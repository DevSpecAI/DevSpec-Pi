import { createHash } from "node:crypto";
import { resolveEndpoint } from "./auth-store.ts";
import { callDevspec, MODEL_TIMEOUT_MS, readDevspecResource } from "./client.ts";
import { unwrapMcpResult } from "./result.ts";
import { UPDATE_EXTENSION_INSTRUCTION } from "./version-mismatch.ts";

/**
 * The product implementation contract, as Pi loads and verifies it.
 *
 * THERE IS NO EXECUTION MODE (DevSpec item 6d085535). DevSpec used to serve two
 * resources — `…/attended` and `…/unattended` — each a projection of one core
 * contract plus a mode overlay, and a delivery named which projection applied.
 * Both are gone: the overlays collapsed into core, the projection went with them,
 * and there is one document at one URI.
 *
 * That removes a whole verification dance as well as a concept. A projection could
 * not authenticate its own parent (`effective_hash` deliberately excluded
 * `contract_hash`), so Pi had to read the compatibility bundle once per
 * authority/version just to confirm the parent hash it had been handed. The served
 * document now hashes its own entire content, so one read verifies itself and the
 * compatibility bundle is only a fallback for a host that cannot read resources.
 *
 * Nothing replaced the mode — no timeout, no patience window, no ask-policy. The
 * rules that used to live in the unattended overlay ("do not assume a human is
 * present", "hand work back truthfully") were never about who was watching, so they
 * are simply core rules now, and the local safety fallback below carries them
 * unconditionally.
 */

export const IMPLEMENTATION_CONTRACT_RESOURCE_URI = "devspec://product/implementation-contract";

export interface ImplementationContractReference {
	contract_version?: string;
	resource_uri: string;
}

export interface ImplementationKickoff {
	kind: "devspec.implementation_kickoff";
	schema_version: 1;
	work: {
		task_ids: string[];
	};
	implementation_contract: {
		contract_version: string;
		resource_uri: string;
	};
}

export interface ImplementationRule {
	id: string;
	phase?: string;
	requirement: string;
	enforcement?: string;
}

/** A served section, kept exactly as DevSpec sent it. */
export type ServedSection = Readonly<Record<string, unknown>>;

/**
 * Who may change the project's record (DevSpec item ff803a1a). Served beside the
 * work-entry and commit-provenance sections since contract 4.4.0. Pi shows it to the
 * model and relays its proposal outcome, and never restates it in its own prose.
 *
 * Read tolerantly (item 39c05c1f): a role, a class or a rule DevSpec adds reaches the
 * model without a Pi release, and a field Pi does not show is ignored rather than
 * refused.
 */
export interface AuthorityContract {
	schema_version: 1;
	classes: Array<{
		class: string;
		meaning: string;
		/** role (or `unattended`) → outcome, in the order DevSpec served them. */
		outcomes: Array<[string, string]>;
	}>;
	proposal_outcome?: { token: string; requirement: string };
	/** The rule texts the model reads, quoted verbatim, in the order shown. */
	rules: Array<{ key: string; text: string }>;
}

/**
 * A section Pi could not read in full — at a schema_version it does not know, or in
 * a shape it does not recognise. It is shown to the model exactly as served, so the
 * model still has DevSpec's words, and the notice says to update the extension.
 */
export interface UnreadSection {
	section: string;
	value: unknown;
}

export interface ImplementationContractContext {
	contractVersion: string;
	contractHash?: string;
	resourceUri: string;
	source: "resource" | "compatibility" | "cache" | "local_safety_fallback";
	rules: ImplementationRule[];
	/** Shown to the model exactly as served: Pi only carries it. */
	workEntryContract?: ServedSection;
	/** Carried as served; Pi does not interpret it. */
	commitProvenanceContract?: ServedSection;
	authorityContract?: AuthorityContract;
	/** Known sections Pi could not read in full; shown as served. */
	unreadSections?: UnreadSection[];
	/** Rules in the core section Pi could not read (no id or requirement). */
	skippedRules?: number;
	/**
	 * Top-level sections this Pi does not implement, present in the document it
	 * verified. Not an error — see `parseContractBundle`.
	 */
	unknownSections?: string[];
	warning?: string;
}

export interface ImplementationContractLoader {
	/** Stable, non-secret authority identity (endpoint + token fingerprint). */
	cacheScope(): Promise<string>;
	readResource(uri: string): Promise<unknown>;
	readCompatibilityBundle(): Promise<unknown>;
}

interface CachedContract extends Omit<ImplementationContractContext, "source" | "warning"> {}

interface ContractCache {
	byIdentity: Map<string, CachedContract>;
	latestByResource: Map<string, CachedContract>;
}

// v7 added the canonical work-entry v2 tracking/plan boundary; v8 added the
// authority_contract section (contract 4.4.0); v9 records unknown top-level
// sections instead of rejecting the document for carrying one; v11 read the
// one-or-more commit-provenance section (item 96f3dfb7); v12 reads every section
// on its own and tolerantly, so a section Pi cannot read is carried as served
// instead of taking the others down (item 39c05c1f). Older parser caches cannot
// authorize: they hold shapes this generation no longer produces.
const CACHE_KEY = Symbol.for("devspec.pi.implementation-contract.v12");

function cache(): ContractCache {
	const root = globalThis as typeof globalThis & { [CACHE_KEY]?: ContractCache };
	const current = root[CACHE_KEY];
	if (!current || !(current.byIdentity instanceof Map) || !(current.latestByResource instanceof Map)) {
		root[CACHE_KEY] = {
			byIdentity: new Map(),
			latestByResource: new Map(),
		};
	}
	return root[CACHE_KEY]!;
}

function cacheIdentity(scope: string, resourceUri: string, contractVersion: string): string {
	return `${scope}\0${resourceUri}\0${contractVersion}`;
}

function latestIdentity(scope: string, resourceUri: string): string {
	return `${scope}\0${resourceUri}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Contract fields are canonical data: padding is invalid, not normalized. */
function exactContractString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value === value.trim() ? value : undefined;
}

/** Text Pi shows the model: taken exactly as served, never trimmed or rewritten. */
function servedText(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

const CONTRACT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CONTRACT_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
/**
 * The document's own format. This — not the product's contract_version — is what
 * says whether Pi can read the document at all. DevSpec raises it only when the
 * whole document changes shape; anything less is a change inside a section, which
 * that section's own schema_version describes.
 */
const READABLE_ROOT_SCHEMA_VERSIONS = new Set([1]);
const PRODUCT_SOURCE = {
	authority: "devspec_product",
	tier: "product_implementation_contract",
} as const;

/** The sections Pi knows by name; anything else is an unknown section. */
const KNOWN_ROOT_KEYS = [
	"kind", "schema_version", "contract_version", "contract_hash", "source", "instruction_boundary",
	"core_implementation_contract", "work_entry_contract", "commit_provenance_contract", "authority_contract",
] as const;

function normalizeForCanonicalJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeForCanonicalJson);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
				.map(([key, nested]) => [key, normalizeForCanonicalJson(nested)]),
		);
	}
	return value;
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(normalizeForCanonicalJson(value));
}

export function hashContractValue(value: unknown): string {
	return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

/** Keys the document carries that this parser knows nothing about. */
function extraKeys(value: Record<string, unknown>, expected: readonly string[]): string[] {
	return Object.keys(value).filter((key) => !expected.includes(key)).sort();
}

/**
 * A section at a schema_version this Pi has a reader for. A section without one is
 * read as version 1, which is how every section that has never changed is served.
 */
function sectionVersionIsReadable(section: Record<string, unknown>, readable: readonly number[]): boolean {
	const version = section.schema_version ?? 1;
	return typeof version === "number" && readable.includes(version);
}

/**
 * The core rules. Pi needs an id and the requirement text; phase and enforcement
 * are carried when present, whatever their value, because Pi only shows them. A
 * rule without an id or a requirement is skipped and counted, never the reason
 * every other rule is thrown away.
 */
function readRules(value: unknown): { rules: ImplementationRule[]; skipped: number } | null {
	const section = asRecord(value);
	if (!section || !sectionVersionIsReadable(section, [1]) || !Array.isArray(section.rules)) return null;
	const rules: ImplementationRule[] = [];
	let skipped = 0;
	for (const candidate of section.rules) {
		const row = asRecord(candidate);
		const id = row ? servedText(row.id) : undefined;
		const requirement = row ? servedText(row.requirement) : undefined;
		if (!row || !id || !requirement) {
			skipped++;
			continue;
		}
		const phase = servedText(row.phase);
		const enforcement = servedText(row.enforcement);
		rules.push({ id, ...(phase ? { phase } : {}), requirement, ...(enforcement ? { enforcement } : {}) });
	}
	return rules.length > 0 ? { rules, skipped } : null;
}

/**
 * Authority rule texts Pi quotes, with the label each is shown under, in order.
 * Any other `*_rule` text DevSpec serves is quoted after these under a label made
 * from its name, so a rule added on the server reaches the model before Pi knows
 * its name. The two left out here are deliberately not shown: role_source_rule
 * matters to people reading the record, not to an agent's next write, and
 * preview_rule describes the web review screen.
 */
const AUTHORITY_RULE_LABELS: ReadonlyArray<readonly [string, string]> = [
	["ownership_rule", "Ownership rule"],
	["unattended_rule", "Unattended rule"],
	["requester_rule", "Requester rule"],
	["flag_ruling_rule", "Queued review-flag rulings"],
];
const AUTHORITY_RULES_NOT_SHOWN = new Set(["role_source_rule", "preview_rule"]);

function readAuthorityContract(value: unknown): AuthorityContract | null {
	const section = asRecord(value);
	if (!section || !sectionVersionIsReadable(section, [1]) || !Array.isArray(section.classes)) return null;
	const classes: AuthorityContract["classes"] = [];
	for (const candidate of section.classes) {
		const row = asRecord(candidate);
		const name = row ? servedText(row.class) : undefined;
		const meaning = row ? servedText(row.meaning) : undefined;
		const outcomes = row ? asRecord(row.outcomes) : null;
		// A class Pi cannot read would be shown with a hole in it; the section is
		// carried as served instead, which still gives the model DevSpec's words.
		if (!name || !meaning || !outcomes) return null;
		const pairs = Object.entries(outcomes).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== "");
		if (pairs.length === 0) return null;
		classes.push({ class: name, meaning, outcomes: pairs });
	}
	if (classes.length === 0) return null;
	const proposal = asRecord(section.proposal_outcome);
	const token = proposal ? servedText(proposal.token) : undefined;
	const requirement = proposal ? servedText(proposal.requirement) : undefined;
	const known = new Set(AUTHORITY_RULE_LABELS.map(([key]) => key));
	const rules: AuthorityContract["rules"] = [];
	for (const [key] of AUTHORITY_RULE_LABELS) {
		const text = servedText(section[key]);
		if (text) rules.push({ key, text });
	}
	for (const key of Object.keys(section)) {
		if (known.has(key) || AUTHORITY_RULES_NOT_SHOWN.has(key) || !key.endsWith("_rule")) continue;
		const text = servedText(section[key]);
		if (text) rules.push({ key, text });
	}
	return {
		schema_version: 1,
		classes,
		...(token && requirement ? { proposal_outcome: { token, requirement } } : {}),
		rules,
	};
}

function parseJsonText(value: unknown, expectedResourceUri: string): unknown {
	const root = asRecord(value);
	if (!root || !Array.isArray(root.contents)) return value;
	const matching = root.contents
		.map(asRecord)
		.find((entry) => entry?.uri === expectedResourceUri && nonEmptyString(entry.text));
	const text = nonEmptyString(matching?.text);
	if (!text) throw new Error(`implementation contract resource did not return ${expectedResourceUri}`);
	return JSON.parse(text);
}

/**
 * Why a served document could not be read at all. Only these take Pi to its
 * built-in rules; everything inside a section degrades that section alone.
 */
class UnreadableContract extends Error {}

/**
 * One parser for both delivery paths, because both carry the same document.
 * `contract_hash` covers every other served field, so a bundle authenticates itself.
 *
 * Each section is read on its own (item 39c05c1f). Pi takes what it shows the model
 * and ignores the rest, so DevSpec can add a field, a role, a rule or a whole section
 * without a Pi release. A section Pi cannot read — a schema_version it has no reader
 * for, or a shape it does not recognise — is carried exactly as served, with a notice
 * saying to update the extension; the other sections stay in force. Before this, one
 * changed field in any section Pi verified sent /devspec.work back to five generic
 * local rules: from 2026-09-14 (flag_ruling_rule, 3dff471b) for three weeks, and again
 * when the server and Pi disagreed about commit references (96f3dfb7).
 *
 * What still refuses the whole document: it is not DevSpec's product contract, its
 * own format (root schema_version) is one Pi cannot read, or the hash does not cover
 * exactly what was served — including any part Pi cannot read, so nothing is
 * accepted unverified.
 */
function parseContractBundle(root: Record<string, unknown>, resourceUri: string): CachedContract {
	if (root.kind !== "devspec.product.implementation_contract") {
		throw new UnreadableContract("the served document is not DevSpec's implementation contract");
	}
	if (typeof root.schema_version !== "number" || !READABLE_ROOT_SCHEMA_VERSIONS.has(root.schema_version)) {
		throw new UnreadableContract(`the contract is in a format (${String(root.schema_version)}) newer than this extension reads`);
	}
	const source = asRecord(root.source);
	if (!source || source.authority !== PRODUCT_SOURCE.authority || source.tier !== PRODUCT_SOURCE.tier) {
		throw new UnreadableContract("the served document does not name DevSpec's product contract as its source");
	}
	const contractVersion = exactContractString(root.contract_version);
	if (!contractVersion || !CONTRACT_VERSION_PATTERN.test(contractVersion)) {
		throw new UnreadableContract("the served document carries no contract version");
	}
	// Hash exactly what was served; no trimming or reconstructed value may
	// authenticate a differently encoded document.
	const contractHash = exactContractString(root.contract_hash);
	const { contract_hash: _contractHash, ...contractHashInput } = root;
	if (!contractHash || !CONTRACT_HASH_PATTERN.test(contractHash) || hashContractValue(contractHashInput) !== contractHash) {
		throw new UnreadableContract("the served document does not match its own hash");
	}

	const unreadSections: UnreadSection[] = [];
	const unread = (section: string) => {
		if (Object.hasOwn(root, section)) unreadSections.push({ section, value: root[section] });
	};
	const core = readRules(root.core_implementation_contract);
	if (!core) unread("core_implementation_contract");
	// Pi shows these two exactly as served and interprets neither, so any object
	// DevSpec sends is one Pi can carry, at any schema_version.
	const workEntryContract = asRecord(root.work_entry_contract) ?? undefined;
	if (!workEntryContract) unread("work_entry_contract");
	const commitProvenanceContract = asRecord(root.commit_provenance_contract) ?? undefined;
	const authorityContract = readAuthorityContract(root.authority_contract) ?? undefined;
	if (!authorityContract) unread("authority_contract");
	const unknownSections = extraKeys(root, KNOWN_ROOT_KEYS);
	return {
		contractVersion,
		contractHash,
		resourceUri,
		// Without readable core rules the model still gets Pi's built-in ones, with
		// the served section beside them and a notice saying which is which.
		rules: core?.rules ?? [...LOCAL_SAFETY_RULES],
		...(workEntryContract ? { workEntryContract } : {}),
		...(commitProvenanceContract ? { commitProvenanceContract } : {}),
		...(authorityContract ? { authorityContract } : {}),
		...(unreadSections.length > 0 ? { unreadSections } : {}),
		...(core && core.skipped > 0 ? { skippedRules: core.skipped } : {}),
		...(unknownSections.length > 0 ? { unknownSections } : {}),
	};
}

function contractFromResourcePayload(payload: unknown, resourceUri: string): CachedContract {
	const root = asRecord(parseJsonText(payload, resourceUri));
	if (!root) throw new UnreadableContract("the served document is not a JSON object");
	return parseContractBundle(root, resourceUri);
}

function contractFromCompatibilityPayload(payload: unknown, resourceUri: string): CachedContract {
	const root = asRecord(payload);
	if (!root) throw new UnreadableContract("the compatibility payload is not a JSON object");
	const bundle = asRecord(root.implementation_contract) ?? root;
	return parseContractBundle(bundle, resourceUri);
}

/**
 * What Pi teaches when it cannot read the canonical contract at all, and beside a
 * served core section it could not read. These are deliberately the same in every
 * situation: the two rules that used to be the unattended overlay are here
 * unconditionally, because "do not invent authority" was never contingent on
 * nobody watching.
 */
const LOCAL_SAFETY_RULES: readonly ImplementationRule[] = [
	{
		id: "pi-fallback.claim-early",
		phase: "claim",
		requirement: "Search, reuse or create the smallest covering item and claim it early when DevSpec is available; an absent claim never blocks local repository work.",
		enforcement: "agent",
	},
	{
		id: "pi-fallback.commit-link",
		phase: "delivery",
		requirement: "Prefer one full [devspec:<task-id>] commit reference and use record_implementation for authoritative post-commit linkage; unsupported Git surfaces rely on server reconciliation.",
		enforcement: "agent",
	},
	{
		id: "pi-fallback.no-human-assumption",
		phase: "implementation",
		requirement: "Do not assume a human is present and do not invent authority or intent.",
		enforcement: "agent",
	},
	{
		id: "pi-fallback.waiting-work-stays-on-its-branch",
		phase: "delivery",
		requirement: "When the claim or the item carries waiting_for_ok (\"Experiment\", or \"Waiting for <name>'s OK\"), build and push the work on its own branch and never merge it into the tracking branch until it has the OK; tell the person plainly.",
		enforcement: "agent",
	},
	{
		id: "pi-fallback.stop-at-implemented",
		phase: "completion",
		requirement: "Record implementation after pushing and stop at implemented; never mark the item done.",
		enforcement: "server",
	},
	{
		id: "pi-fallback.truthful-handoff",
		phase: "failure",
		requirement: "On failure, use fail_work_item or release_work_item truthfully; never leave failed work implementing.",
		enforcement: "agent",
	},
];

function localSafetyFallback(resourceUri: string, warning: string): ImplementationContractContext {
	return {
		contractVersion: "pi-local-fail-open-v1",
		resourceUri,
		source: "local_safety_fallback",
		warning,
		rules: [...LOCAL_SAFETY_RULES],
	};
}

function validateResourceUri(uri: string): boolean {
	return uri === IMPLEMENTATION_CONTRACT_RESOURCE_URI;
}

function storeContract(scope: string, value: CachedContract): void {
	const current = cache();
	current.byIdentity.set(cacheIdentity(scope, value.resourceUri, value.contractVersion), value);
	current.latestByResource.set(latestIdentity(scope, value.resourceUri), value);
}

/** How a section is named to a person, who has never seen the document's keys. */
const SECTION_LABELS: Readonly<Record<string, string>> = {
	core_implementation_contract: "the core rules",
	work_entry_contract: "the rules for starting work",
	commit_provenance_contract: "the rules for linking commits",
	authority_contract: "the rules for who may change the project's record",
};

function sectionLabel(section: string): string {
	return SECTION_LABELS[section] ?? section;
}

function listOf(items: readonly string[]): string {
	return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * The notice an accepted contract carries when part of it is something this Pi
 * cannot read. It never downgrades what Pi did read; it says what was not, that
 * the rest is in force, and how to fix it.
 */
function partialReadNotice(contract: CachedContract): string | undefined {
	const parts: string[] = [];
	const unread = contract.unreadSections ?? [];
	if (unread.length > 0) {
		const coreUnread = unread.some((entry) => entry.section === "core_implementation_contract");
		parts.push(`This version of the DevSpec Pi extension could not fully read ${listOf(unread.map((entry) => sectionLabel(entry.section)))} in DevSpec's rules for agents, so ${unread.length === 1 ? "that part is" : "those parts are"} shown exactly as DevSpec sent ${unread.length === 1 ? "it" : "them"}${coreUnread ? ", next to Pi's built-in rules" : ""}.`);
	}
	if (contract.skippedRules) {
		parts.push(`${contract.skippedRules} of DevSpec's core rules could not be read by this version of the DevSpec Pi extension.`);
	}
	const unknown = contract.unknownSections ?? [];
	if (unknown.length > 0) {
		parts.push(`DevSpec's rules for agents include ${unknown.length === 1 ? "a part" : "parts"} this version of the DevSpec Pi extension does not know (${unknown.join(", ")}); get_workflow_rules with include_implementation_contract returns the whole contract.`);
	}
	if (parts.length === 0) return undefined;
	return [...parts, "Everything else is loaded and in force.", UPDATE_EXTENSION_INSTRUCTION].join(" ");
}

function acceptedContract(
	contract: CachedContract,
	source: "resource" | "compatibility" | "cache",
	warning?: string,
): ImplementationContractContext {
	const notice = partialReadNotice(contract);
	const combined = [warning, notice].filter(Boolean).join(" ");
	return { ...contract, source, ...(combined ? { warning: combined } : {}) };
}

function cachedContract(
	scope: string,
	resourceUri: string,
	expectedVersion?: string,
): ImplementationContractContext | null {
	const current = cache();
	const value = expectedVersion
		? current.byIdentity.get(cacheIdentity(scope, resourceUri, expectedVersion))
		: current.latestByResource.get(latestIdentity(scope, resourceUri));
	return value ? acceptedContract(value, "cache") : null;
}

/**
 * Load the product contract at work entry. A delivery that names a version can use
 * that exact immutable cache entry; an unversioned one refreshes and may fall back
 * to the latest cached contract, because there is no version it was promised.
 */
export async function loadImplementationContext(input: {
	reference?: ImplementationContractReference;
	loader: ImplementationContractLoader;
	/** Pump/bond authority checkpoint for each asynchronous preparation stage. */
	assertCurrent?: () => void;
}): Promise<ImplementationContractContext> {
	const resourceUri = input.reference?.resource_uri ?? IMPLEMENTATION_CONTRACT_RESOURCE_URI;
	const expectedVersion = nonEmptyString(input.reference?.contract_version);
	const scope = await input.loader.cacheScope();
	input.assertCurrent?.();
	if (!validateResourceUri(resourceUri)) {
		return localSafetyFallback(
			IMPLEMENTATION_CONTRACT_RESOURCE_URI,
			`The delivered implementation-contract pointer was not ${IMPLEMENTATION_CONTRACT_RESOURCE_URI}; the Pi safety fallback is active.`,
		);
	}

	if (expectedVersion) {
		const exact = cachedContract(scope, resourceUri, expectedVersion);
		if (exact) return exact;
	}

	const errors: string[] = [];
	// A document that arrived and could not be read is a different situation from
	// one that never arrived: the first needs an extension update, the second needs
	// the service back. Saying "unavailable" for both sends whoever reads it looking in
	// the wrong place.
	let served = false;
	try {
		const payload = await input.loader.readResource(resourceUri);
		input.assertCurrent?.();
		served = true;
		const contract = contractFromResourcePayload(payload, resourceUri);
		if (expectedVersion && contract.contractVersion !== expectedVersion) {
			throw new Error(`resource version ${contract.contractVersion} did not match kickoff version ${expectedVersion}`);
		}
		storeContract(scope, contract);
		return acceptedContract(contract, "resource");
	} catch (error) {
		input.assertCurrent?.();
		errors.push(error instanceof Error ? error.message : String(error));
	}

	try {
		const payload = await input.loader.readCompatibilityBundle();
		input.assertCurrent?.();
		served = true;
		const contract = contractFromCompatibilityPayload(payload, resourceUri);
		if (expectedVersion && contract.contractVersion !== expectedVersion) {
			throw new Error(`compatibility version ${contract.contractVersion} did not match kickoff version ${expectedVersion}`);
		}
		storeContract(scope, contract);
		return acceptedContract(contract, "compatibility");
	} catch (error) {
		input.assertCurrent?.();
		errors.push(error instanceof Error ? error.message : String(error));
	}

	input.assertCurrent?.();
	const retained = expectedVersion
		? cachedContract(scope, resourceUri, expectedVersion)
		: cachedContract(scope, resourceUri);
	if (retained) {
		return {
			...retained,
			warning: [
				`DevSpec contract refresh failed; using the retained ${retained.contractVersion} contract.`,
				retained.warning,
			].filter(Boolean).join(" "),
		};
	}
	return localSafetyFallback(
		resourceUri,
		served
			? `DevSpec sent its rules for agents in a form this version of the DevSpec Pi extension cannot read (${errors.join("; ") || "unknown error"}), so Pi is using its short built-in rules instead. ${UPDATE_EXTENSION_INSTRUCTION}`
			: `DevSpec's rules for agents could not be fetched (${errors.join("; ") || "unknown error"}), so Pi is using its short built-in rules instead.`,
	);
}

export function createImplementationContractLoader(token: string): ImplementationContractLoader {
	const tokenFingerprint = createHash("sha256").update(token, "utf8").digest("hex").slice(0, 24);
	return {
		cacheScope: async () => `${await resolveEndpoint()}#${tokenFingerprint}`,
		readResource: (uri) => readDevspecResource(token, uri, {
			lane: "work",
			timeoutMs: MODEL_TIMEOUT_MS,
		}),
		readCompatibilityBundle: async () => {
			const raw = await callDevspec(
				token,
				"get_workflow_rules",
				{ include_implementation_contract: true },
				{ lane: "work", timeoutMs: MODEL_TIMEOUT_MS },
			);
			const unwrapped = unwrapMcpResult(raw);
			if (unwrapped.isError) throw new Error(unwrapped.text || "get_workflow_rules failed");
			return unwrapped.details ?? unwrapped.text;
		},
	};
}

export function buildImplementationKickoff(input: {
	taskIds: readonly string[];
	context: ImplementationContractContext;
	contractReference?: ImplementationContractReference;
}): ImplementationKickoff {
	const taskIds = [...new Set(input.taskIds.map((id) => id.trim()).filter(Boolean))];
	if (taskIds.length === 0) throw new Error("implementation kickoff requires at least one task id");
	const suppliedVersion = nonEmptyString(input.contractReference?.contract_version);
	if (
		input.context.source !== "local_safety_fallback" && suppliedVersion &&
		suppliedVersion !== input.context.contractVersion
	) {
		throw new Error("implementation kickoff contract version did not match the loaded canonical contract");
	}
	if (input.contractReference?.resource_uri && input.contractReference.resource_uri !== input.context.resourceUri) {
		throw new Error("implementation kickoff contract resource did not match the loaded canonical contract");
	}
	const reference = {
		// During an outage preserve the immutable server pointer the delivery
		// carried. The local fallback affects guidance, not work authorization.
		contract_version: suppliedVersion ?? input.context.contractVersion,
		resource_uri: input.contractReference?.resource_uri ?? input.context.resourceUri,
	};
	const contractVersion = nonEmptyString(reference.contract_version);
	if (!contractVersion || !validateResourceUri(reference.resource_uri)) {
		throw new Error("implementation kickoff requires a versioned product-contract reference");
	}
	return {
		kind: "devspec.implementation_kickoff",
		schema_version: 1,
		work: {
			task_ids: taskIds,
		},
		implementation_contract: {
			contract_version: contractVersion,
			resource_uri: reference.resource_uri,
		},
	};
}

export function formatImplementationKickoffHeader(kickoff: ImplementationKickoff): string {
	return `DevSpec work kickoff: ${JSON.stringify(kickoff)}`;
}

export function formatImplementationContext(context: ImplementationContractContext): string {
	const identity = [
		`version=${context.contractVersion}`,
		context.contractHash ? `hash=${context.contractHash}` : null,
		`source=${context.source}`,
	].filter(Boolean).join(" · ");
	return [
		`${context.source === "local_safety_fallback" ? "Local fail-open fallback (the canonical product contract was not loaded; the notice below says why)" : "Product implementation contract"} (${identity})`,
		...(context.warning ? [`Availability notice (tell the person you are working with): ${context.warning}`] : []),
		...(context.workEntryContract ? [
			"Canonical work entry contract (the only task/session-plan boundary):",
			JSON.stringify(context.workEntryContract),
		] : []),
		...(context.authorityContract ? formatAuthorityContract(context.authorityContract) : []),
		// A section this Pi could not read in full still reaches the model in
		// DevSpec's own words; only Pi's summary of it is missing.
		...(context.unreadSections ?? []).flatMap((entry) => [
			`${entry.section}, exactly as DevSpec sent it (this version of the extension could not read it in full):`,
			JSON.stringify(entry.value),
		]),
		"Rules:",
		...context.rules.map((rule) => `- [${rule.id}] ${rule.requirement}`),
	].join("\n");
}

/** Shown before the proposal outcome; every other rule text follows it. */
const AUTHORITY_RULES_BEFORE_PROPOSAL = new Set(["ownership_rule", "unattended_rule", "requester_rule"]);

function authorityRuleLabel(key: string): string {
	const known = AUTHORITY_RULE_LABELS.find(([name]) => name === key)?.[1];
	if (known) return known;
	const words = key.replace(/_/g, " ").trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The authority section as the model reads it: the classes with the outcomes the
 * server actually returns, the rules that qualify those outcomes, and what a queued
 * proposal means. Verbs and role meanings stay in the served document — the model
 * reads the outcome of each call; it never has to predict one.
 *
 * The class table is printed with `ownership_rule` and `unattended_rule` beside it
 * because on its own it is wrong about the two writes an agent makes most (DevSpec
 * item 689d44cb): the table says an `add` commits unattended, while the served
 * unattended rule records `memory.record` and `artifact.create` as proposals and
 * refuses personal-scope writes; and the ownership rule is what makes closing your
 * own item an add and closing a colleague's an overrule. Every rule is quoted from
 * the served document, never paraphrased — this plugin does not own these sentences.
 * Outcomes are printed for whichever roles DevSpec serves, in its order, so a role
 * added on the server is shown without a Pi release.
 */
export function formatAuthorityContract(authority: AuthorityContract): string[] {
	const rule = (entry: { key: string; text: string }) => `- ${authorityRuleLabel(entry.key)}: ${entry.text}`;
	return [
		"Write authority (authority_contract — who may change the project's record is decided per call by the server from the verb, the person's project role and whether the run is unattended; read every write's outcome, never predict it):",
		...authority.classes.map((cls) =>
			`- ${cls.class}: ${cls.meaning} Outcomes — ${cls.outcomes.map(([role, outcome]) => `${role.replace(/_/g, " ")} ${outcome}`).join(", ")}.`,
		),
		...authority.rules.filter((entry) => AUTHORITY_RULES_BEFORE_PROPOSAL.has(entry.key)).map(rule),
		...(authority.proposal_outcome ? [`- ${authority.proposal_outcome.token}: ${authority.proposal_outcome.requirement}`] : []),
		...authority.rules.filter((entry) => !AUTHORITY_RULES_BEFORE_PROPOSAL.has(entry.key)).map(rule),
	];
}

export function resetImplementationContractCache(): void {
	const root = globalThis as typeof globalThis & { [CACHE_KEY]?: ContractCache };
	root[CACHE_KEY] = {
		byIdentity: new Map(),
		latestByResource: new Map(),
	};
}
