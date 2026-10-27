/**
 * The request chain (item 7a4d04fd): every wake carries the request it continues.
 *
 * DevSpec used to learn who asked for a write from connection state that holds
 * one current request, so work an agent did after a background job, a wait or
 * a directed question finished was credited to whoever spoke last, and two
 * people's requests on one agent bled into each other. The server now keeps
 * the requests a connection is carrying (`report_request`) and every write
 * names the one it serves (`request_ref`, host-only: the model never sees it).
 * The Claude Code plugin implements the same rules (hooks/scripts/requests.mjs).
 *
 * - A **request** is a room command (opened with its delivery provenance_ref)
 *   or a prompt the owner typed at this terminal. It closes once its own work
 *   is finished: no run is carrying it, nothing it launched is still to wake
 *   the agent, and no directed question it asked is still waiting.
 * - A **turn** is one Pi run. It is woken for one request (current), and other
 *   requests may reach it while it works (joined): a second command or typed
 *   prompt mid-run, several commands in one delivery, or a wake that carries
 *   another request. When the requests a turn carries would not all be
 *   recorded the same way (different people, or one person at the terminal
 *   and in a room, or nobody's request joined by somebody's) and the agent has
 *   not named one with `serve_request`, a write that records who asked is
 *   refused rather than guessed.
 * - Every **launch** (a background task, an async subagent run, a directed
 *   question) is recorded against what its turn served: a request, "none"
 *   (the turn positively served nobody's request), or "unstated" (not known).
 *   Its wake continues that request while it is open; a launch recorded none
 *   stamps none; anything else — a closed request, an unstated launch, a wake
 *   nothing recorded — stamps nothing, so DevSpec resolves who asked as it
 *   always has. A missing record never becomes "none".
 * - An **automation run** is positively nobody's request: its turn stamps
 *   "none", which DevSpec records as the automation while that run is running
 *   on the connection (else as the agent's own initiative). Left unstamped, a
 *   live command would win DevSpec's default and be credited instead.
 *
 * Pi loads every extension file with a fresh module graph, so the live chain
 * and the typed-input ledger sit on globalThis under Symbol.for keys (the
 * provenance-refs / bond-state pattern). Nothing here holds a token,
 * capability, prompt or message body beyond the exact input texts the ledger
 * needs for one run.
 */

import { randomUUID } from "node:crypto";
import { backgroundTaskFromLaunch, isBackgroundLaunchTool } from "./background-observer.ts";
import { automaticBackgroundTaskId } from "./turn-lifecycle.ts";

export const REQUEST_LINK_ENTRY = "devspec-request-link";
/** The ref a turn that positively continues nobody's request carries. */
export const NO_REQUEST = "none";
/** A turn or launch whose request is not known here: its writes name nothing. */
export const UNSTATED = "unstated";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LINK_CAP = 512;

export type CarriedRequestKind = "command" | "typed_prompt";

/** What a write is stamped with. null = stamp nothing (DevSpec's own resolution). */
export type RequestStamp = string | null;

/** The capability-authenticated report_request call. Throws on refusal or transport failure. */
export interface RequestTransport {
	call(args: Record<string, unknown>): Promise<unknown>;
}

export interface RequestLinkIdentity {
	id: string;
	kind: CarriedRequestKind;
	provenanceRef?: string;
	messageId?: string;
	/** A room command the connection's owner sent (its delivery authority is the owner's). */
	fromOwner?: boolean;
	commandTurnId?: string;
	commandMessageId?: string;
}

/**
 * Journal row for one launch: what it was recorded against (a request, "none",
 * "unstated"), the other requests an undecided turn carried (`also`), and
 * whether its end reaches the agent as a notification. `request: null` says its
 * wake has come back (or it ended without one).
 */
export interface RequestLinkEntry {
	version: 1;
	nativeSessionId: string;
	connectionId: string;
	key: string;
	aliases?: string[];
	request: RequestLinkIdentity | typeof NO_REQUEST | typeof UNSTATED | null;
	also?: RequestLinkIdentity[];
	notifies?: boolean;
}

/** A request the current turn carries, as a refusal lists it. */
export interface CarriedEntry {
	id: string;
	kind: CarriedRequestKind | "none";
	messageId?: string;
	current: boolean;
}

interface CarriedRequest extends RequestLinkIdentity {
	/** The server's id: the host's own, or the one a command was already open under. */
	serverId?: string;
	requester?: string;
	state: "opening" | "open" | "closing" | "closed";
	/** DevSpec refused or could not be reached when it was opened: never carried. */
	failed?: boolean;
	/**
	 * DevSpec knows it but reports it already closed (it closed in a /reload gap,
	 * or with its connection): never carried, but a write that continues it may
	 * still name it — DevSpec resolves a closed request to its requester.
	 */
	closedOnServer?: boolean;
	ready: Promise<boolean>;
	seq: number;
}

interface Launch {
	/** A local request id, NO_REQUEST or UNSTATED. */
	request: string;
	also: string[];
	notifies: boolean;
	notified: boolean;
}

/** What a launch made now is recorded against. */
export interface LaunchSnapshot {
	request: string;
	also: string[];
}

/** How long a decision waits, in total, for the opens it depends on. */
export const OPEN_WAIT_MS = 3_000;

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function boundedMap<K, V>(map: Map<K, V>, key: K, value: V): void {
	map.delete(key);
	map.set(key, value);
	while (map.size > LINK_CAP) {
		const oldest = map.keys().next();
		if (oldest.done) break;
		map.delete(oldest.value);
	}
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(fallback), timeoutMs);
		if (typeof timer.unref === "function") timer.unref();
		promise.then(
			(value) => { clearTimeout(timer); resolve(value); },
			() => { clearTimeout(timer); resolve(fallback); },
		);
	});
}

/** One wake's work keys; `terminal` means the work itself is finished. */
export interface WakeKey {
	key: string;
	terminal: boolean;
}

export const taskKey = (id: string): string => `task:${id}`;
export const subagentKey = (id: string): string => `subagent:${id}`;
export const questionKey = (id: string): string => `question:${id}`;

/**
 * The requests one connection is carrying, what the current turn carries, and
 * what each launch was made for. One instance per connection id; a different
 * connection is different authority and gets a fresh chain.
 */
export class RequestChain {
	readonly connectionId: string;
	private readonly transport: RequestTransport;
	private readonly journal: ((entry: Omit<RequestLinkEntry, "version" | "nativeSessionId" | "connectionId">) => void) | null;
	private readonly onError: (what: "open" | "close" | "restore" | "persist") => void;
	private readonly requests = new Map<string, CarriedRequest>();
	private readonly byProvenance = new Map<string, string>();
	private readonly launches = new Map<string, Launch>();
	/** Alternate spelling of a launch key (an async subagent's directory). */
	private readonly aliases = new Map<string, string>();
	/** The request the turn was woken for (local id), NO_REQUEST, UNSTATED, or null before any input. */
	private current: string | null = null;
	/** Requests that reached this turn besides the current one. */
	private joined = new Set<string>();
	/** The agent named the current request itself (serve_request) since anything last joined. */
	private chosen = false;
	private turnStarted = false;
	/** Every request this turn carried at any point: none of them closes before the turn ends. */
	private touched = new Set<string>();
	/**
	 * The commands and typed prompts that reached this turn since it started or
	 * the agent last named one, one batch per message. A message none of whose
	 * requests DevSpec opened clears the current request: its writes are
	 * unstamped, never credited to whoever was current before.
	 */
	private arrivals: string[][] = [];
	/** Launches rebuilt from the journal whose work has not yet been checked against the host. */
	private readonly restored = new Set<string>();
	private seq = 0;
	private disposed = false;
	private readonly closing = new Set<Promise<void>>();

	constructor(input: {
		connectionId: string;
		transport: RequestTransport;
		journal?: (entry: Omit<RequestLinkEntry, "version" | "nativeSessionId" | "connectionId">) => void;
		onError?: (what: "open" | "close" | "restore" | "persist") => void;
	}) {
		this.connectionId = input.connectionId;
		this.transport = input.transport;
		this.journal = input.journal ?? null;
		this.onError = input.onError ?? (() => {});
	}

	// ---- Opening requests -----------------------------------------------------

	/** A room command reached the agent: carry it (a command already carried is the request it already is). */
	openCommand(input: { provenanceRef: string; messageId?: string; commandTurnId?: string; commandMessageId?: string; fromOwner?: boolean }): string | null {
		if (this.disposed || !UUID.test(input.provenanceRef)) return null;
		const ref = input.provenanceRef.toLowerCase();
		const existing = this.byProvenance.get(ref);
		if (existing && this.isOpen(existing)) return existing;
		const request = this.create({ id: randomUUID(), kind: "command", provenanceRef: ref,
			...(input.messageId ? { messageId: input.messageId } : {}),
			...(input.fromOwner === true ? { fromOwner: true } : {}),
			...(input.commandTurnId ? { commandTurnId: input.commandTurnId } : {}),
			...(input.commandMessageId ? { commandMessageId: input.commandMessageId } : {}) });
		boundedMap(this.byProvenance, ref, request.id);
		return request.id;
	}

	/** The owner typed a prompt at this terminal: carry it as the owner's request. */
	openTyped(): string | null {
		if (this.disposed) return null;
		return this.create({ id: randomUUID(), kind: "typed_prompt" }).id;
	}

	private create(identity: RequestLinkIdentity, verifyOnly = false): CarriedRequest {
		const request: CarriedRequest = { ...identity, state: "opening", ready: Promise.resolve(false), seq: ++this.seq };
		this.requests.set(request.id, request);
		while (this.requests.size > LINK_CAP) {
			const oldest = [...this.requests.values()].find((candidate) => candidate.state === "closed");
			if (!oldest) break;
			this.requests.delete(oldest.id);
		}
		request.ready = (async () => {
			try {
				const raw = await this.transport.call({
					action: "open",
					request_id: request.id,
					kind: request.kind,
					...(request.kind === "command" && request.provenanceRef ? { provenance_ref: request.provenanceRef } : {}),
				});
				const receipt = record(raw);
				const serverId = typeof receipt?.request_id === "string" && UUID.test(receipt.request_id) ? receipt.request_id : null;
				if (!serverId || (receipt?.status !== "open" && receipt?.status !== "closed")) throw new Error("malformed request receipt");
				request.serverId = serverId;
				if (typeof receipt.requested_by_user_id === "string") request.requester = receipt.requested_by_user_id;
				if (receipt.status !== "open") {
					request.state = "closed";
					request.closedOnServer = true;
					return false;
				}
				if (request.state === "opening") request.state = "open";
				return request.state === "open" || request.state === "closing";
			} catch {
				// Not carried: a turn woken for it stamps nothing, and it never makes a
				// turn ambiguous. DevSpec resolves who asked as it did before requests.
				request.state = "closed";
				request.failed = true;
				this.onError(verifyOnly ? "restore" : "open");
				return false;
			}
		})();
		return request;
	}

	private isOpen(id: string | null | undefined): boolean {
		const state = id ? this.requests.get(id)?.state : undefined;
		return state === "opening" || state === "open";
	}

	/** Open, or known to DevSpec as closed: a write that continues it may name it. */
	private isStampable(id: string | null | undefined): boolean {
		return this.isOpen(id) || Boolean(id && this.requests.get(id)?.closedOnServer);
	}

	/**
	 * Whether "nobody's request" may be offered: DevSpec refuses it while any
	 * open request on this connection is someone else's (a teammate's command),
	 * so it is offered only when every open request is the owner's own — typed
	 * here, or a room command the owner sent.
	 */
	private noneAllowed(): boolean {
		for (const request of this.requests.values()) {
			if (!this.isOpen(request.id)) continue;
			if (request.kind !== "typed_prompt" && request.fromOwner !== true) return false;
		}
		return true;
	}

	/** Wait, until a deadline, for the opens these requests depend on. */
	private async settleOpens(ids: Iterable<string | null>, deadline: number): Promise<void> {
		const pending = [...new Set(ids)].flatMap((id) => {
			const request = id ? this.requests.get(id) : undefined;
			return request?.state === "opening" ? [request.ready] : [];
		});
		const remaining = deadline - Date.now();
		if (pending.length && remaining > 0) await withTimeout(Promise.all(pending).then(() => undefined), remaining, undefined);
	}

	private carriedIds(): (string | null)[] {
		return [this.currentRequestId(), ...this.joined, ...this.arrivals.flat()];
	}

	// ---- The turn -------------------------------------------------------------

	/** True once something this run carries has bound it (its first command, prompt, wake or notice). */
	get turnActive(): boolean {
		return this.turnStarted;
	}

	/** The local id of the request the current turn serves, if it is one. */
	currentRequestId(): string | null {
		return this.current && UUID.test(this.current) ? this.current : null;
	}

	/** A new turn: it serves the request that woke it, and carries `also` besides. */
	startTurn(ref: string | null, also: readonly string[] = []): void {
		if (this.disposed) return;
		const previous = this.touched;
		this.current = ref === NO_REQUEST || ref === UNSTATED || (ref && this.isStampable(ref)) ? ref : UNSTATED;
		this.joined = new Set(also.filter((id) => id !== this.current && this.isOpen(id)));
		this.chosen = false;
		this.turnStarted = true;
		this.arrivals = [];
		this.touched = new Set([...(this.currentRequestId() ? [this.current!] : []), ...this.joined]);
		for (const id of previous) if (!this.touched.has(id)) this.maybeClose(id);
	}

	/**
	 * Requests reached the agent (commands of one delivery oldest first, or a
	 * typed prompt). The first input of a run is woken for the newest and
	 * carries the rest; mid-run they join the turn.
	 */
	arrive(ids: readonly string[]): void {
		if (this.disposed) return;
		if (ids.length === 0) { this.arriveUnknown(); return; }
		if (!this.turnStarted) this.startTurn(ids[ids.length - 1]!, ids.slice(0, -1));
		else for (const id of ids) this.join(id);
		this.arrivals.push([...ids]);
	}

	/**
	 * An input whose request is not known here (a command or prompt DevSpec did
	 * not open, a command message with no binding, a wake nothing here
	 * launched): a turn it starts names nothing, and mid-run it clears the
	 * current request — never keeps the previous one.
	 */
	arriveUnknown(): void {
		if (this.disposed) return;
		if (!this.turnStarted) this.startTurn(UNSTATED);
		else { this.current = UNSTATED; this.chosen = false; }
	}

	/**
	 * Input that is positively nobody's request (an automation run, a launch made
	 * for nobody's): a turn it starts stamps "none". Mid-run it joins as
	 * nobody's: a request the turn was serving is still carried, so the turn
	 * carries both and is undecided until the agent names one.
	 */
	arriveNobody(): void {
		if (this.disposed) return;
		if (!this.turnStarted) { this.startTurn(NO_REQUEST); return; }
		if (this.current === NO_REQUEST) return;
		const previous = this.currentRequestId();
		this.current = NO_REQUEST;
		this.chosen = false;
		this.arrivals = [];
		if (previous) this.joined.add(previous);
	}

	/** Input that is nobody's in particular (another extension's send): it starts an unstated turn and joins a running one unchanged. */
	arriveUntyped(): void {
		if (!this.disposed && !this.turnStarted) this.startTurn(UNSTATED);
	}

	private join(id: string): void {
		if (!this.isOpen(id) || id === this.current) return;
		this.joined.add(id);
		this.touched.add(id);
		this.chosen = false;
	}

	/** The run settled: every request it carried closes unless work it launched is still to wake. */
	endTurn(): void {
		const released = [...this.touched];
		this.current = null;
		this.joined = new Set();
		this.chosen = false;
		this.turnStarted = false;
		this.touched = new Set();
		this.arrivals = [];
		for (const id of released) this.maybeClose(id);
	}

	// ---- What the turn carries ---------------------------------------------------

	/**
	 * Who a request is from as a write would record it: a person, and whether at
	 * this terminal or in a room. A requester not yet known is its own person —
	 * never assumed to be the same as anyone else.
	 */
	private attribution(request: CarriedRequest): string {
		return `${request.requester ?? `unknown:${request.id}`}:${request.kind === "typed_prompt" ? "terminal" : "room"}`;
	}

	/**
	 * The requests the turn carries when they would not all be recorded the same
	 * way (whether or not the agent has named one); null when every write this
	 * turn makes has one answer.
	 */
	private carriedNow(): CarriedEntry[] | null {
		const carried: CarriedRequest[] = [];
		const add = (id: string | null) => {
			const request = id && this.isOpen(id) ? this.requests.get(id) : undefined;
			if (request && !carried.includes(request)) carried.push(request);
		};
		add(this.currentRequestId());
		for (const id of this.joined) add(id);
		const nobody = this.current === NO_REQUEST && carried.length > 0;
		if (new Set(carried.map((request) => this.attribution(request))).size + (nobody ? 1 : 0) < 2) return null;
		return [
			...(nobody && this.noneAllowed() ? [{ id: NO_REQUEST, kind: "none" as const, current: true }] : []),
			...carried.map((request) => ({ id: request.id, kind: request.kind, ...(request.messageId ? { messageId: request.messageId } : {}), current: request.id === this.current })),
		];
	}

	/** The requests this turn carries that would be recorded differently, once their opens answer (bounded). */
	async undecided(timeoutMs = OPEN_WAIT_MS): Promise<CarriedEntry[] | null> {
		await this.settleOpens(this.carriedIds(), Date.now() + timeoutMs);
		return this.carriedNow();
	}

	/**
	 * The requests this turn carries when they would not all be recorded the
	 * same way and the agent has not named one; null when every write this turn
	 * makes has one answer. One DevSpec did not open is not carried.
	 */
	async ambiguity(timeoutMs = OPEN_WAIT_MS): Promise<CarriedEntry[] | null> {
		if (this.chosen || this.joined.size === 0) return null;
		const carried = await this.undecided(timeoutMs);
		return this.chosen ? null : carried;
	}

	/**
	 * The agent names the request its writes now serve (serve_request): one of
	 * the requests this turn carries that would be recorded differently — the
	 * command with this message id, the prompt typed here, or nobody's when
	 * nobody's request is among them. Holds until another request reaches it.
	 */
	async serve(input: { messageId?: unknown; terminal?: unknown; none?: unknown }, timeoutMs = OPEN_WAIT_MS): Promise<{ ok: true; serving: string } | { ok: false; error: string }> {
		const messageId = typeof input.messageId === "string" && input.messageId.trim() ? input.messageId.trim().toLowerCase() : null;
		const terminal = input.terminal === true;
		const none = input.none === true;
		if ([Boolean(messageId), terminal, none].filter(Boolean).length !== 1) {
			return { ok: false, error: "Name exactly one: message_id, terminal: true, or none: true." };
		}
		const carried = await this.undecided(timeoutMs);
		if (!carried) {
			return { ok: false, error: "Nothing to name: every request this turn carries would be recorded the same way, so its writes already have one answer." };
		}
		const match = carried.filter((entry) => none ? entry.kind === "none"
			: terminal ? entry.kind === "typed_prompt"
				: entry.kind === "command" && entry.messageId?.toLowerCase() === messageId);
		const ref = match.length ? match[match.length - 1]!.id : null;
		if (!ref) return { ok: false, error: "That is not one of the requests this turn carries. Name one the refusal listed." };
		const previous = this.currentRequestId();
		this.current = ref;
		this.chosen = true;
		this.turnStarted = true;
		this.arrivals = [];
		// The request it was serving is still carried: naming it again switches back.
		if (previous && previous !== ref) this.joined.add(previous);
		if (UUID.test(ref)) this.touched.add(ref);
		return { ok: true, serving: ref === NO_REQUEST ? "nobody's request: your own initiative" : this.describe(ref) };
	}

	private describe(id: string): string {
		const request = this.requests.get(id);
		if (!request) return id;
		return request.kind === "typed_prompt" ? "the prompt your owner typed at this terminal" : `the room command with message_id ${request.messageId ?? "(unknown)"}`;
	}

	// ---- Launches and wakes -----------------------------------------------------

	/**
	 * What a launch made now belongs to: the current request while it is open,
	 * "none" when the turn positively serves nobody's, "unstated" otherwise —
	 * with the other requests an undecided turn was carrying.
	 */
	launchSnapshot(): LaunchSnapshot {
		const cleared = this.arrivalFailed();
		const request = cleared ? UNSTATED : this.current === NO_REQUEST ? NO_REQUEST
			: this.currentRequestId() && this.isStampable(this.current) ? this.current! : UNSTATED;
		const also = ((this.chosen ? null : this.carriedNow()) ?? []).map((entry) => entry.id).filter((id) => UUID.test(id) && id !== request);
		return { request, also };
	}

	/** The same, once the carried opens have answered (bounded), so who asked is known. */
	async launchSnapshotReady(timeoutMs = OPEN_WAIT_MS): Promise<LaunchSnapshot> {
		await this.settleOpens(this.carriedIds(), Date.now() + timeoutMs);
		return this.launchSnapshot();
	}

	/** Record a launch (every one, so its wake is never mistaken for one nothing here started). */
	recordLaunch(key: string, snapshot: LaunchSnapshot, options: { aliases?: string[]; notifies?: boolean } = {}): void {
		if (this.disposed || !key) return;
		const launch: Launch = { request: snapshot.request, also: [...snapshot.also], notifies: options.notifies !== false, notified: false };
		boundedMap(this.launches, key, launch);
		const aliases = (options.aliases ?? []).filter(Boolean);
		for (const alias of aliases) boundedMap(this.aliases, alias, key);
		this.writeJournal(key, aliases, launch);
	}

	/** Work that ends without a wake (killed, a cancelled question, gone after a reload) stops holding its requests open. */
	endLaunch(key: string): void {
		const resolved = this.resolveAlias(key);
		this.restored.delete(resolved);
		const launch = this.launches.get(resolved);
		if (!launch || launch.notified) return;
		launch.notified = true;
		this.writeJournal(resolved, [], null);
		this.releaseLaunch(launch);
	}

	/** Every launch key and alias, for text correlation of a wake that carries no ids. */
	knownKeys(): string[] {
		return [...this.launches.keys(), ...this.aliases.keys()];
	}

	resolveAlias(key: string): string {
		return this.aliases.get(key) ?? key;
	}

	/**
	 * A wake reached the agent. It continues the open requests its launches were
	 * made for — preferring any still open over one that has finished — or
	 * nobody's when a launch was made for nobody's; a wake that carries both is
	 * undecided until the agent names one. When none of that is known (finished
	 * requests, unstated launches, nothing here launched it) it names nothing.
	 * The first input of a run is woken for it; mid-run its requests join the
	 * turn. Terminal keys stop holding their requests open — after they joined,
	 * so nothing closes underneath the turn. Returns whether any key was one
	 * this chain launched.
	 *
	 * `alongside`: the notice reached the agent together with a prompt that
	 * already decided what the turn serves (it was the session leaf when that
	 * prompt started). Its requests join; it neither clears nor replaces.
	 */
	wake(keys: readonly WakeKey[], options: { alongside?: boolean } = {}): boolean {
		if (this.disposed) return false;
		const matched = keys.map((entry) => ({ ...entry, key: this.resolveAlias(entry.key) }))
			.filter((entry) => this.launches.has(entry.key));
		if (matched.length === 0) {
			if (!options.alongside) this.arriveUnknown();
			return false;
		}
		const requests: string[] = [];
		let closed: string | null = null;
		let nobody = false;
		for (const entry of matched) {
			const launch = this.launches.get(entry.key)!;
			if (launch.request === NO_REQUEST) nobody = true;
			for (const id of [launch.request, ...launch.also]) {
				if (UUID.test(id) && this.isOpen(id) && !requests.includes(id)) requests.push(id);
			}
			if (!closed && this.requests.get(launch.request)?.closedOnServer) closed = launch.request;
		}
		// A request DevSpec reports closed (it closed in a /reload gap) still names
		// its requester: the wake continues it when nothing it carries is open.
		const ref = nobody ? NO_REQUEST : requests[0] ?? closed ?? UNSTATED;
		const also = nobody ? requests : requests.slice(1);
		if (!this.turnStarted) {
			this.startTurn(ref, also);
		} else if (options.alongside) {
			for (const id of requests) this.join(id);
		} else {
			if (ref === NO_REQUEST) this.arriveNobody();
			else if (ref === UNSTATED) this.arriveUnknown();
			for (const id of requests) this.join(id);
		}
		this.noteNotified(matched);
		return true;
	}

	/** A notification reached the conversation: its work is done and stops holding its requests open. */
	noteNotified(keys: readonly WakeKey[]): void {
		for (const entry of keys) {
			if (!entry.terminal) continue;
			const key = this.resolveAlias(entry.key);
			this.restored.delete(key);
			const launch = this.launches.get(key);
			if (!launch || launch.notified) continue;
			launch.notified = true;
			this.writeJournal(key, [], null);
			this.releaseLaunch(launch);
		}
	}

	private releaseLaunch(launch: Launch): void {
		for (const id of [launch.request, ...launch.also]) if (UUID.test(id)) this.maybeClose(id);
	}

	private pending(id: string): boolean {
		for (const launch of this.launches.values()) {
			if (launch.notifies && !launch.notified && (launch.request === id || launch.also.includes(id))) return true;
		}
		return false;
	}

	private maybeClose(id: string): void {
		const request = this.requests.get(id);
		if (this.disposed || !request || this.touched.has(id) || this.pending(id)) return;
		if (request.state !== "open" && request.state !== "opening") return;
		request.state = "closing";
		const closing = (async () => {
			const opened = await request.ready;
			if (!opened || !request.serverId) { request.state = "closed"; return; }
			try {
				await this.transport.call({ action: "close", request_id: request.serverId, reason: "host_finished" });
			} catch {
				// Recorded closed regardless: a request this host no longer carries is
				// never stamped again, and DevSpec closes it with the connection anyway.
				this.onError("close");
			}
			request.state = "closed";
		})();
		this.closing.add(closing);
		void closing.finally(() => this.closing.delete(closing));
	}

	// ---- Writes -------------------------------------------------------------------

	/**
	 * What a write made now carries: the current request's server id once it is
	 * open, "none" for a turn that positively serves nobody's request, or null —
	 * stamp nothing — for an unstated turn or a request whose open has not
	 * answered within the wait, or never landed.
	 */
	async stamp(timeoutMs = OPEN_WAIT_MS): Promise<RequestStamp> {
		await this.settleOpens([this.currentRequestId(), ...this.arrivals.flat()], Date.now() + timeoutMs);
		if (this.arrivalFailed()) return null;
		if (this.current === NO_REQUEST) return NO_REQUEST;
		const id = this.currentRequestId();
		const request = id ? this.requests.get(id) : undefined;
		if (!request || request.failed || !request.serverId) return null;
		return request.state === "open" || request.state === "closing" || request.closedOnServer ? request.serverId : null;
	}

	/**
	 * Why stamp() named nothing. "unstated": the turn continues no request this
	 * host knows of, which is a fact DevSpec records as such and never guesses
	 * past. "not_recorded": the request this turn serves never reached DevSpec
	 * (its open failed or has not answered), so the write loses who asked (the
	 * case found on 15 Oct, item 306fb64a note c9afcfce).
	 */
	unstampedReason(): "unstated" | "not_recorded" {
		if (this.arrivalFailed()) return "not_recorded";
		if (this.current === NO_REQUEST) return "unstated";
		const id = this.currentRequestId();
		const request = id ? this.requests.get(id) : undefined;
		if (!request) return "unstated";
		return request.failed || !request.serverId ? "not_recorded" : "unstated";
	}

	private arrivalFailed(): boolean {
		return this.arrivals.some((batch) => batch.length > 0 && batch.every((id) => this.requests.get(id)?.failed === true));
	}

	// ---- Lifecycle ------------------------------------------------------------------

	/**
	 * Rebuild the launches a previous instance journaled on this branch, read in
	 * order: a launch whose notice already appears later in the branch has
	 * reached the agent and is not restored. Each remaining launch's requests are
	 * re-opened by their own ids to learn whether they are still carried.
	 * `noticeKeys` reads a branch entry's wake keys (custom messages only).
	 */
	restore(entries: readonly unknown[], nativeSessionId: string, noticeKeys?: (entry: Record<string, unknown>, known: readonly string[]) => WakeKey[]): number {
		if (this.disposed) return 0;
		const latest = new Map<string, RequestLinkEntry>();
		const aliases = new Map<string, string>();
		for (const value of entries) {
			const row = record(value);
			if (!row) continue;
			if (row.type === "custom" && row.customType === REQUEST_LINK_ENTRY) {
				const entry = parseRequestLinkEntry(row.data);
				if (!entry || entry.nativeSessionId !== nativeSessionId || entry.connectionId !== this.connectionId) continue;
				latest.delete(entry.key);
				latest.set(entry.key, entry);
				for (const alias of entry.aliases ?? []) aliases.set(alias, entry.key);
			} else if (row.type === "custom_message" && noticeKeys && latest.size > 0) {
				let keys: WakeKey[] = [];
				try { keys = noticeKeys(row, [...latest.keys(), ...aliases.keys()]); } catch { /* not a notice */ }
				for (const key of keys) if (key.terminal) latest.delete(aliases.get(key.key) ?? key.key);
			}
		}
		const carry = (identity: RequestLinkIdentity): string => {
			const known = this.requests.get(identity.id);
			if (known) return known.id;
			const request = this.create(identity, true);
			if (request.kind === "command" && request.provenanceRef) boundedMap(this.byProvenance, request.provenanceRef, request.id);
			return request.id;
		};
		let restored = 0;
		for (const entry of latest.values()) {
			if (entry.request === null || this.launches.has(entry.key)) continue;
			const request = typeof entry.request === "string" ? entry.request : carry(entry.request);
			const also = (entry.also ?? []).map(carry);
			this.launches.set(entry.key, { request, also, notifies: entry.notifies !== false, notified: false });
			for (const alias of entry.aliases ?? []) boundedMap(this.aliases, alias, entry.key);
			this.restored.add(entry.key);
			restored += 1;
		}
		return restored;
	}

	/** Restored launches still waiting to be checked against what the host is actually running. */
	restoredKeys(): string[] {
		return [...this.restored];
	}

	/**
	 * Check restored launches against the host: one it reports no longer
	 * running is over (its wake will not come to this instance) and stops
	 * holding its requests open; one it cannot tell about waits for a later check.
	 */
	reconcileRestored(running: (key: string) => boolean | undefined): number {
		let ended = 0;
		for (const key of [...this.restored]) {
			const verdict = running(key);
			if (verdict === undefined) continue;
			this.restored.delete(key);
			if (verdict === false) { this.endLaunch(key); ended += 1; }
		}
		return ended;
	}

	/** Process exit or reload: close what has nothing pending; work still to wake keeps its requests for after reload. */
	async shutdown(timeoutMs = 3_000): Promise<void> {
		this.endTurn();
		await withTimeout(Promise.allSettled([...this.closing]).then(() => undefined), timeoutMs, undefined);
		this.dispose();
	}

	/** Different authority (stop, revive, replacement connection): forget everything locally. */
	dispose(): void {
		this.disposed = true;
		this.current = null;
		this.joined = new Set();
		this.turnStarted = false;
	}

	private identity(id: string): RequestLinkIdentity | null {
		const request = this.requests.get(id);
		if (!request) return null;
		return {
			id: request.id, kind: request.kind,
			...(request.provenanceRef ? { provenanceRef: request.provenanceRef } : {}),
			...(request.messageId ? { messageId: request.messageId } : {}),
			...(request.fromOwner ? { fromOwner: true } : {}),
			...(request.commandTurnId ? { commandTurnId: request.commandTurnId } : {}),
			...(request.commandMessageId ? { commandMessageId: request.commandMessageId } : {}),
		};
	}

	private writeJournal(key: string, aliases: string[], launch: Launch | null): void {
		if (!this.journal) return;
		try {
			const request = launch === null ? null
				: launch.request === NO_REQUEST || launch.request === UNSTATED ? launch.request
					: this.identity(launch.request) ?? UNSTATED;
			const also = launch ? launch.also.map((id) => this.identity(id)).filter((value): value is RequestLinkIdentity => value !== null) : [];
			this.journal({ key, ...(aliases.length ? { aliases } : {}), request,
				...(also.length ? { also } : {}), ...(launch ? { notifies: launch.notifies } : {}) });
		} catch {
			this.onError("persist");
		}
	}

	/** Test/diagnostic view; never posted anywhere. */
	snapshot(): { current: string | null; joined: string[]; chosen: boolean; requests: Array<{ id: string; kind: CarriedRequestKind; state: string }>; pending: string[] } {
		return {
			current: this.current, joined: [...this.joined], chosen: this.chosen,
			requests: [...this.requests.values()].map((request) => ({ id: request.id, kind: request.kind, state: request.state })),
			pending: [...this.launches.entries()].filter(([, launch]) => launch.notifies && !launch.notified).map(([key]) => key),
		};
	}
}

const LINK_KEYS = ["version", "nativeSessionId", "connectionId", "key", "aliases", "request", "also", "notifies"];
const REQUEST_KEYS = ["id", "kind", "provenanceRef", "messageId", "fromOwner", "commandTurnId", "commandMessageId"];

function parseIdentity(value: unknown): RequestLinkIdentity | null {
	const row = record(value);
	if (!row || Object.keys(row).some((key) => !REQUEST_KEYS.includes(key))) return null;
	if (typeof row.id !== "string" || !UUID.test(row.id) || (row.kind !== "command" && row.kind !== "typed_prompt")) return null;
	if (row.kind === "command" && (typeof row.provenanceRef !== "string" || !UUID.test(row.provenanceRef))) return null;
	if (row.kind === "typed_prompt" && row.provenanceRef !== undefined) return null;
	if (row.fromOwner !== undefined && row.fromOwner !== true) return null;
	for (const field of ["messageId", "commandTurnId", "commandMessageId"] as const) {
		if (row[field] !== undefined && (typeof row[field] !== "string" || !(row[field] as string) || (row[field] as string).length > 128)) return null;
	}
	return {
		id: row.id, kind: row.kind,
		...(typeof row.provenanceRef === "string" ? { provenanceRef: row.provenanceRef } : {}),
		...(typeof row.messageId === "string" ? { messageId: row.messageId } : {}),
		...(row.fromOwner === true ? { fromOwner: true } : {}),
		...(typeof row.commandTurnId === "string" ? { commandTurnId: row.commandTurnId } : {}),
		...(typeof row.commandMessageId === "string" ? { commandMessageId: row.commandMessageId } : {}),
	};
}

/** Strict allowlist parse: a malformed row restores nothing. */
export function parseRequestLinkEntry(value: unknown): RequestLinkEntry | null {
	const row = record(value);
	if (!row || row.version !== 1 || Object.keys(row).some((key) => !LINK_KEYS.includes(key))) return null;
	for (const field of ["nativeSessionId", "connectionId", "key"] as const) {
		if (typeof row[field] !== "string" || !row[field] || (row[field] as string).length > 512) return null;
	}
	let aliases: string[] | undefined;
	if (row.aliases !== undefined) {
		if (!Array.isArray(row.aliases) || row.aliases.length > 4 ||
			row.aliases.some((alias) => typeof alias !== "string" || !alias || alias.length > 1024)) return null;
		aliases = row.aliases as string[];
	}
	let request: RequestLinkEntry["request"];
	if (row.request === null || row.request === NO_REQUEST || row.request === UNSTATED) request = row.request;
	else {
		request = parseIdentity(row.request);
		if (!request) return null;
	}
	let also: RequestLinkIdentity[] | undefined;
	if (row.also !== undefined) {
		if (!Array.isArray(row.also) || row.also.length > 8) return null;
		also = [];
		for (const value of row.also) {
			const identity = parseIdentity(value);
			if (!identity) return null;
			also.push(identity);
		}
	}
	if (row.notifies !== undefined && typeof row.notifies !== "boolean") return null;
	return {
		version: 1,
		nativeSessionId: row.nativeSessionId as string,
		connectionId: row.connectionId as string,
		key: row.key as string,
		...(aliases ? { aliases } : {}),
		request,
		...(also ? { also } : {}),
		...(typeof row.notifies === "boolean" ? { notifies: row.notifies } : {}),
	};
}

// ---- Launch and wake correlation ------------------------------------------

/**
 * A background task a launch tool started (pi-background-tasks' receipt), and
 * whether its end reaches the agent as a notification: it does unless the
 * receipt says notifyOnCompletion false.
 */
export function backgroundLaunch(toolName: string, result: unknown, isError = false): { id: string; notifies: boolean } | null {
	if (isError) return null;
	const id = backgroundTaskFromLaunch(toolName, result, isError)?.id ?? automaticBackgroundTaskId(toolName, result, isError);
	if (!id) return null;
	const outer = record(result);
	const details = record(outer?.details) ?? outer;
	return { id, notifies: record(details?.task)?.notifyOnCompletion !== false };
}

/**
 * A call that would start work which wakes the agent later: a background task,
 * an async subagent run (pi-subagents runs async unless told otherwise; an
 * `action` call manages runs), or a directed question.
 */
export function isLaunchCall(toolName: string, input: unknown): boolean {
	const args = record(input) ?? {};
	if (isBackgroundLaunchTool(toolName)) return true;
	if (toolName === "subagent") return args.action === undefined && args.async !== false;
	return toolName === "manage_directed_question" && args.action === "create";
}

/** pi-subagents' async launch receipt: details.asyncId (the run id) and details.asyncDir. */
export function subagentLaunch(toolName: string, result: unknown, isError = false): { id: string; aliases: string[] } | null {
	if (isError || toolName !== "subagent") return null;
	const outer = record(result);
	const details = record(outer?.details) ?? outer;
	const id = typeof details?.asyncId === "string" && details.asyncId.trim() ? details.asyncId.trim() : null;
	if (!id || id.length > 256) return null;
	const dir = typeof details?.asyncDir === "string" && details.asyncDir.trim() ? details.asyncDir.trim() : null;
	return { id, aliases: dir && dir.length <= 1024 ? [dir] : [] };
}

/** A directed question this segment asked (manage_directed_question create). */
export function askedQuestionId(toolName: string, args: unknown, result: unknown, isError = false): string | null {
	if (isError || toolName !== "manage_directed_question" || record(args)?.action !== "create") return null;
	const outer = record(result);
	const details = record(outer?.details) ?? outer;
	const id = record(details?.question)?.id;
	return typeof id === "string" && UUID.test(id) ? id : null;
}

/** A directed question this segment cancelled: it will never wake anyone. */
export function cancelledQuestionId(toolName: string, args: unknown, isError = false): string | null {
	const input = record(args);
	if (isError || toolName !== "manage_directed_question" || input?.action !== "cancel") return null;
	return typeof input.question_id === "string" && UUID.test(input.question_id) ? input.question_id : null;
}

const SUBAGENT_TERMINAL = new Set(["completed", "failed", "stopped"]);
const TASK_TERMINAL = new Set(["completed", "failed", "killed"]);

/**
 * The background task a pi-background-tasks notice names, whatever its status
 * (`terminal` only for completed/failed/killed — the same states
 * backgroundTaskNotificationId resolves).
 */
export function backgroundNotificationTask(text: string, details?: unknown): { id: string; terminal: boolean } | null {
	const row = record(details);
	let id: string | null = null;
	let status: string | null = null;
	if (row) {
		const task = record(row.task);
		for (const value of [row.id, row.taskId, task?.id]) {
			if (typeof value === "string" && value.trim()) { id = value.trim(); break; }
		}
		const value = row.status ?? task?.status;
		if (typeof value === "string") status = value.trim().toLowerCase();
	}
	if (!id && !/<background-task-notification|<task-id>/i.test(text)) return null;
	id ??= text.match(/<task-id>\s*([^<]+?)\s*<\/task-id>/i)?.[1]?.trim() ?? null;
	status ??= text.match(/<status>\s*([^<]+?)\s*<\/status>/i)?.[1]?.trim().toLowerCase() ?? null;
	if (!id || id.length > 200) return null;
	return { id, terminal: status !== null && TASK_TERMINAL.has(status) };
}

/**
 * The work keys a wake message carries. A background-task notice names its
 * task (`task`, from backgroundNotificationTask); pi-subagents' notices carry
 * details.runs with runId/asyncDir, and a workflow child's names its workflow
 * run; a directed-question continuation carries details.event's question id.
 * A notice without structured ids is matched, best effort, by any launched
 * subagent id or directory its text names.
 */
export function wakeKeys(input: {
	text: string;
	customType?: string | null;
	details?: unknown;
	task?: { id: string; terminal: boolean } | null;
	questionCustomTypes?: readonly string[];
	known?: readonly string[];
}): WakeKey[] {
	const keys: WakeKey[] = [];
	if (input.task) keys.push({ key: taskKey(input.task.id), terminal: input.task.terminal });
	const details = record(input.details);
	if (input.customType && input.questionCustomTypes?.includes(input.customType)) {
		const questionId = record(details?.event)?.question_id;
		if (typeof questionId === "string" && UUID.test(questionId)) keys.push({ key: questionKey(questionId), terminal: true });
		return keys;
	}
	const trimmed = input.text.trim();
	if (input.customType === "subagent-incremental-child-notify" || /^Workflow child /.test(trimmed)) {
		// One child of a workflow settled; the workflow (its launch) goes on.
		const run = trimmed.match(/^Workflow run: (\S+)$/m)?.[1];
		if (run && run.length <= 256) keys.push({ key: subagentKey(run), terminal: false });
		return keys;
	}
	const subagentText = /^(?:Background task|Detached foreground task) (?:completed|failed|paused|stopped): \*\*/.test(trimmed) ||
		/^Background tasks completed \(\d+\)/.test(trimmed);
	if (input.customType === "subagent-notify" || (!input.task && subagentText)) {
		const runs = Array.isArray(details?.runs) ? details.runs : [];
		for (const value of runs.slice(0, 64)) {
			const run = record(value);
			const status = typeof run?.status === "string" ? run.status.toLowerCase() : "";
			const terminal = SUBAGENT_TERMINAL.has(status);
			if (typeof run?.runId === "string" && run.runId.trim()) keys.push({ key: subagentKey(run.runId.trim()), terminal });
			else if (typeof run?.asyncDir === "string" && run.asyncDir.trim()) keys.push({ key: run.asyncDir.trim(), terminal });
		}
		if (keys.length === 0 && input.known?.length) {
			const terminal = /^(?:Background task|Detached foreground task) (?:completed|failed|stopped)\b/.test(trimmed) ||
				/^Background tasks completed \(\d+\)/.test(trimmed);
			for (const key of input.known) {
				const needle = key.startsWith("subagent:") ? key.slice("subagent:".length) : key.startsWith("task:") || key.startsWith("question:") ? "" : key;
				if (needle && input.text.includes(needle)) keys.push({ key, terminal });
			}
		}
	}
	return keys;
}

// ---- Typed input ----------------------------------------------------------

interface InputRecord {
	typed: boolean;
	text: string;
	behavior?: "steer" | "followUp";
}

/**
 * Which user messages the owner typed (item 7a4d04fd). Pi's `input` event says
 * where input came from; the message_start that later carries it does not.
 * Every input is recorded in order — interactive and RPC input typed, the
 * extension's own sends untyped unless the extension marked them as sent on
 * the owner's behalf (/devspec.work) — and each user message that no command
 * binding claimed consumes one record: the one with its exact text, or else
 * the oldest typed one (Pi may have expanded a typed template or skill).
 * Automation runs, harness wakes and notices never arrive through `input` as
 * typed, so they are never admitted as typed turns.
 */
export class TypedInputLedger {
	private records: InputRecord[] = [];
	private marks: string[] = [];

	/** The extension sends this exact text because the owner asked for it at this terminal. */
	markTyped(text: string): void {
		this.marks.push(text);
		while (this.marks.length > 16) this.marks.shift();
	}

	unmarkTyped(text: string): void {
		const index = this.marks.indexOf(text);
		if (index !== -1) this.marks.splice(index, 1);
	}

	noteInput(event: { text?: unknown; source?: unknown; streamingBehavior?: unknown }): boolean {
		const text = typeof event.text === "string" ? event.text : "";
		const behavior = event.streamingBehavior === "steer" || event.streamingBehavior === "followUp" ? event.streamingBehavior : undefined;
		// An idle input starts its own run at once. An older idle record nobody
		// consumed belonged to input another handler swallowed; it must not be
		// inherited by the next message.
		if (!behavior) this.records = this.records.filter((entry) => entry.behavior !== undefined);
		let typed = event.source === "interactive" || event.source === "rpc";
		if (event.source === "extension") {
			const index = this.marks.indexOf(text);
			if (index !== -1) { this.marks.splice(index, 1); typed = true; }
		}
		this.records.push({ typed, text, ...(behavior ? { behavior } : {}) });
		while (this.records.length > 64) this.records.shift();
		return typed;
	}

	/** A user message no command binding claimed: true when the owner typed it. */
	takeForMessage(text: string): boolean {
		let index = this.records.findIndex((entry) => entry.text === text);
		if (index === -1) index = this.records.findIndex((entry) => entry.typed);
		if (index === -1) return false;
		const [entry] = this.records.splice(index, 1);
		return entry?.typed === true;
	}

	/** A user message claimed some other way (a command, an automation run): drop its record. */
	dropForMessage(text: string): void {
		const index = this.records.findIndex((entry) => entry.text === text);
		if (index !== -1) this.records.splice(index, 1);
	}

	/** The run settled: anything not consumed by now never became a message. */
	expire(): void {
		this.records = [];
	}

	pending(): number {
		return this.records.length;
	}
}


// ---- Process-wide stores --------------------------------------------------

interface ChainStore {
	chain: RequestChain | null;
	ledger: TypedInputLedger;
	/** Shows serve_request (devspec-remote owns the active tool set). */
	showServeTool: ((enabled: boolean) => void) | null;
}

const STORE_KEY = Symbol.for("devspec.pi.request-chain.v1");

function store(): ChainStore {
	const root = globalThis as typeof globalThis & { [STORE_KEY]?: ChainStore };
	if (!root[STORE_KEY]) root[STORE_KEY] = { chain: null, ledger: new TypedInputLedger(), showServeTool: null };
	root[STORE_KEY].showServeTool ??= null;
	return root[STORE_KEY];
}

export function installRequestChain(chain: RequestChain | null): void {
	store().chain = chain;
}

export function activeRequestChain(): RequestChain | null {
	return store().chain;
}

export function typedInputLedger(): TypedInputLedger {
	return store().ledger;
}

export function installServeToolSwitch(show: ((enabled: boolean) => void) | null): void {
	store().showServeTool = show;
}

/** The extension's own send on the owner's behalf (/devspec.work) is typed input. */
export function markTypedSend(text: string): void {
	store().ledger.markTyped(text);
}

export function unmarkTypedSend(text: string): void {
	store().ledger.unmarkTyped(text);
}

// ---- Stamping a write ---------------------------------------------------------

/** Whether a tool's wire schema takes request_ref (the server's work-claim provenance tools). */
export function declaresRequestRef(inputSchema: unknown): boolean {
	const properties = record(record(inputSchema)?.properties);
	return Boolean(properties && "request_ref" in properties);
}

export const SERVE_REQUEST_TOOL = "serve_request";

function describeCarried(entry: CarriedEntry): string {
	if (entry.kind === "none") return `- nobody's request (your own initiative): ${SERVE_REQUEST_TOOL} with none: true`;
	if (entry.kind === "typed_prompt") return `- the prompt your owner typed at this terminal: ${SERVE_REQUEST_TOOL} with terminal: true`;
	return `- the room command with message_id ${entry.messageId ?? "(unknown)"}: ${SERVE_REQUEST_TOOL} with message_id "${entry.messageId ?? "<id>"}"`;
}

const CARRIES = "This turn carries more than one request that would be recorded differently (different people, someone at this terminal and in a room, or a request and nobody's)";

/** A DevSpec write that records who asked, refused until the agent names a request. */
export function ambiguityRefusal(carried: readonly CarriedEntry[]): string {
	return [
		`${CARRIES}, and DevSpec records who asked for this write.`,
		`Say which request it serves with ${SERVE_REQUEST_TOOL}, then make the call again. One of:`,
		...carried.map(describeCarried),
		"Writes follow that request until another reaches you. Name each request before its writes when you switch.",
	].join("\n");
}

/** Work that would wake the agent later, refused until the agent names the request it serves. */
export function launchRefusal(carried: readonly CarriedEntry[]): string {
	return [
		`${CARRIES}, and this starts work that continues one of them when it wakes you.`,
		`Say which request it serves with ${SERVE_REQUEST_TOOL}, then start it again. One of:`,
		...carried.map(describeCarried),
	].join("\n");
}

/**
 * The request a DevSpec write serves (item 7a4d04fd), for a tool whose wire
 * schema takes request_ref: stamped from the turn, never from the model — a
 * model-supplied request_ref is always removed first. When the turn carries
 * requests that would be recorded differently and the agent has not named
 * one, the write is refused, unless it already cites the work it belongs to
 * (work_claim_ref) or the command it serves (provenance_ref), which DevSpec
 * reads first.
 */
export async function stampRequestRef(input: {
	params: Record<string, unknown>;
	inputSchema: unknown;
	connectionId: string | undefined;
	timeoutMs?: number;
}): Promise<{ args: Record<string, unknown>; unstamped?: UnstampedReason } | { deny: string }> {
	if (!declaresRequestRef(input.inputSchema)) return { args: input.params };
	const { request_ref: _model, ...params } = input.params;
	const shared = store();
	const chain = shared.chain;
	// Not connected to DevSpec: no requests are carried, so there is nothing to name.
	if (!chain || !input.connectionId) return { args: params };
	// The chain belongs to a connection this one replaced; its requests are not this connection's.
	if (chain.connectionId !== input.connectionId) return { args: params, unstamped: "connection_changed" };
	try {
		const cites = typeof params.work_claim_ref === "string" || typeof params.provenance_ref === "string";
		const carried = cites ? null : await chain.ambiguity(input.timeoutMs);
		if (carried) {
			shared.showServeTool?.(true);
			return { deny: ambiguityRefusal(carried) };
		}
		const ref = await chain.stamp(input.timeoutMs);
		if (ref) return { args: { ...params, request_ref: ref } };
		// A citation names the work itself, which DevSpec reads first.
		if (cites) return { args: params };
		const why = chain.unstampedReason();
		return why === "unstated" ? { args: params } : { args: params, unstamped: why };
	} catch {
		return { args: params, unstamped: "error" };
	}
}

/**
 * Why a write that should have named its request went without one. The write
 * still goes: when DevSpec can't tell who asked, a change is never refused or
 * held for that (ADR "Protecting intent" §13). It is no longer silent: the
 * agent is told, so it can tell the person whose work it was.
 */
export type UnstampedReason = "connection_changed" | "not_recorded" | "error";

export function unstampedNote(reason: UnstampedReason): string {
	const why = reason === "connection_changed"
		? "this agent's DevSpec connection was replaced since the request reached it"
		: reason === "not_recorded"
			? "the request never reached DevSpec"
			: "Pi could not work out which request it served";
	return `Note: DevSpec was not told which request this write served (${why}), so it records that it couldn't tell who asked. If this was for someone, tell them it was done for them.`;
}

export const SERVE_REQUEST_DESCRIPTION =
	"Say which request your next DevSpec writes serve, when this turn carries requests from more than one person " +
	"(or from a person and nobody) and a write was refused for it. Pass exactly one: message_id of the room command, " +
	"terminal: true for the prompt your owner typed at this terminal, or none: true for your own initiative. " +
	"Writes follow it until another request reaches you.";

export const SERVE_REQUEST_SCHEMA = {
	type: "object",
	properties: {
		message_id: { type: "string", description: "The message_id of the room command your next writes serve, as the refusal listed it." },
		terminal: { type: "boolean", description: "true: the prompt your owner typed at this terminal." },
		none: { type: "boolean", description: "true: nobody's request (your own initiative)." },
	},
	additionalProperties: false,
} as const;

/** The serve_request host tool joins the active set only while a turn carries more than one request. */
export function withServeRequestToolActive(active: readonly string[], enabled: boolean): string[] {
	const rest = active.filter((name) => name !== SERVE_REQUEST_TOOL);
	return enabled ? [...rest, SERVE_REQUEST_TOOL] : rest;
}
