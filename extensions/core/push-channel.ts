/**
 * DevSpec Pi — push channel client (SSE wake stream).
 *
 * Client for GET /api/mcp/connection-stream (devspecv2, item 0026da9f).
 * The stream emits wake/ended/hello frames; the client fetches the packaged
 * turn via poll_connection on wake (wake+fetch — packaging stays server-side
 * in ONE place). Falls back to the held long-poll when the channel is
 * unavailable (older server, proxy that buffers SSE, etc).
 */

export interface PushChannelHandlers {
	/** A wake frame arrived — something moved; fetch now. */
	onWake(): void;
	/** The server tore the connection down (carries end_reason). */
	onEnded(endReason: string | null): void;
	/** The stream closed (cleanly or by error) — the pump decides what next. */
	onClose(reason: string): void;
}

export interface PushChannelOptions {
	/** The MCP endpoint URL (…/api/mcp); the stream lives under it. */
	mcpUrl: string;
	token: string;
	connectionId: string;
	/** Main intake capability only; side polls never inherit this negotiation. */
	systemNoticeVersion?: 1;
	handlers: PushChannelHandlers;
	/** Abort to close deliberately. */
	signal: AbortSignal;
}

/** Parse an SSE frame block into {event, data}. Returns null for comments/keepalives. */
export function parseSseFrame(block: string): { event: string; data: string } | null {
	let event = "message";
	const dataLines: string[] = [];
	for (const line of block.split("\n")) {
		if (line.startsWith(":")) return null; // comment / keepalive
		if (line.startsWith("event:")) event = line.slice(6).trim();
		else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
	}
	if (dataLines.length === 0) return null;
	return { event, data: dataLines.join("\n") };
}

/**
 * Reconnect backoff for unexpected drops (item 8b0c162b). A native host holds
 * ONE stream; a proxy hiccup or brief network blip should NOT cost the rest of
 * the bond's lifetime on the slow path. Returns the delay before the next
 * reconnect attempt, or null when quick retries are exhausted and the caller
 * should settle into the held long-poll fallback.
 *
 * `attempts` counts consecutive drops of SHORT-LIVED streams: a stream that
 * stayed up past `healthyMs` proved the path works, so its drop restarts the
 * backoff from zero instead of burning one of the few quick retries.
 */
export const PUSH_RECONNECT_BACKOFF_MS = [1_000, 4_000, 10_000] as const;
export const PUSH_HEALTHY_MS = 30_000;

export function nextPushReconnectDelayMs(
	attempts: number,
	openedAt: number | undefined,
	now: number,
	healthyMs: number = PUSH_HEALTHY_MS,
): number | null {
	const effective = openedAt !== undefined && now - openedAt > healthyMs ? 0 : attempts;
	if (effective >= PUSH_RECONNECT_BACKOFF_MS.length) return null;
	return PUSH_RECONNECT_BACKOFF_MS[effective];
}

/**
 * Open and pump the SSE channel until it closes or the signal aborts.
 * Resolves when the stream ends; rejects only on connect-level failure
 * (non-2xx, network) so the caller can choose fallback BEFORE any frames
 * flowed.
 */
export function pushChannelUrl(opts: Pick<PushChannelOptions, "mcpUrl" | "connectionId" | "systemNoticeVersion">): string {
	const query = new URLSearchParams({ connection_id: opts.connectionId });
	if (opts.systemNoticeVersion === 1) query.set("system_notice_version", "1");
	return `${opts.mcpUrl.replace(/\/$/, "")}/connection-stream?${query.toString()}`;
}

export async function openPushChannel(opts: PushChannelOptions): Promise<void> {
	const url = pushChannelUrl(opts);
	const res = await fetch(url, {
		method: "GET",
		headers: {
			authorization: `Bearer ${opts.token}`,
			accept: "text/event-stream",
		},
		signal: opts.signal,
	});

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`push channel HTTP ${res.status}: ${body.slice(0, 200)}`);
	}
	if (!res.body) throw new Error("push channel: no response body");

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let sep: number;
			while ((sep = buffer.indexOf("\n\n")) !== -1) {
				const block = buffer.slice(0, sep);
				buffer = buffer.slice(sep + 2);
				const frame = parseSseFrame(block);
				if (!frame) continue;
				if (frame.event === "wake") {
					opts.handlers.onWake();
				} else if (frame.event === "ended") {
					let reason: string | null = null;
					try {
						reason = (JSON.parse(frame.data) as { end_reason?: string | null }).end_reason ?? null;
					} catch { /* keep null */ }
					opts.handlers.onEnded(reason);
				}
				// hello frames need no action — the bond already knows its facts.
			}
		}
		opts.handlers.onClose("stream closed");
	} catch (err) {
		if (opts.signal.aborted) return; // deliberate close — not an error
		opts.handlers.onClose(err instanceof Error ? err.message : String(err));
	}
}
