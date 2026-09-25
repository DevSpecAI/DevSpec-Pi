import { parseIngressAttachment, type IngressAttachment } from './remote-payload.ts';
import { MAX_ATTACHMENTS, MAX_TOTAL_ATTACHMENT_BYTES } from './attachment-limits.ts';

export interface CommandOffer {
	version: 1;
	connection_id: string;
	source_session_id: string;
	attachment_id: string;
	source_message_id: string;
	blocking_attempt_id: string;
	attachments: IngressAttachment[];
}
export interface CommandOfferScope {
	nativeSessionId: string;
	connectionId: string;
	sessionId: string;
	attachmentId: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keys = ['version', 'connection_id', 'source_session_id', 'attachment_id', 'source_message_id', 'blocking_attempt_id', 'attachments'];
/** Offers contain no executable text or provenance and never enter model context. */
export function parseCommandOfferPoll(value: unknown, scope: CommandOfferScope): { supported: boolean; stale: boolean; offer: CommandOffer | null } {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid command offer response');
	const root = value as Record<string, unknown>;
	if (root.command_offer_version === undefined) return { supported: false, stale: false, offer: null };
	if (root.command_offer_version !== 1 || typeof root.command_handoff_stale !== 'boolean') throw new Error('Unsupported command offer response');
	if (root.command_offer === null) return { supported: true, stale: root.command_handoff_stale, offer: null };
	const raw = root.command_offer;
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid command offer');
	const row = raw as Record<string, unknown>;
	if (Object.keys(row).length !== keys.length || Object.keys(row).some(key => !keys.includes(key)) || row.version !== 1) throw new Error('Invalid command offer fields');
	for (const key of keys.slice(1, -1)) if (typeof row[key] !== 'string' || !uuid.test(row[key] as string)) throw new Error('Invalid command offer identity');
	if (row.connection_id !== scope.connectionId || row.source_session_id !== scope.sessionId || row.attachment_id !== scope.attachmentId) throw new Error('Command offer attachment changed');
	if (!Array.isArray(row.attachments) || row.attachments.length > MAX_ATTACHMENTS) throw new Error('Invalid command offer attachments');
	const attachments = row.attachments.map((item, index) => parseIngressAttachment(item, `command offer.attachments[${index}]`));
	if (attachments.reduce((sum, item) => sum + (item.size_bytes ?? 0), 0) > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error('Command offer attachment budget exceeded');
	return { supported: true, stale: root.command_handoff_stale, offer: { version: 1,
		connection_id: row.connection_id as string, source_session_id: row.source_session_id as string,
		attachment_id: row.attachment_id as string, source_message_id: row.source_message_id as string,
		blocking_attempt_id: row.blocking_attempt_id as string, attachments } };
}

export function commandOfferAction(input: {
	current: boolean; exactInteractionApplied: boolean; foregroundIdle: boolean;
	hasPendingMessages: boolean; preemptEnabled: boolean; abortAlreadyRequested: boolean;
}): 'ignore' | 'wait' | 'abort' | 'ready' {
	if (!input.current || !input.exactInteractionApplied) return 'ignore';
	if (input.foregroundIdle) return input.hasPendingMessages ? 'wait' : 'ready';
	return input.preemptEnabled && !input.abortAlreadyRequested ? 'abort' : 'wait';
}

export const COMMAND_PREEMPT_ENTRY = 'devspec-command-preemption';
/** Negative cancellation budget only; journal/history can NEVER authorize work. */
export class CommandPreemptionBudget {
	private sources = new Set<string>();
	private scope: string | null = null;
	bind(scope: CommandOfferScope | null, entries: readonly unknown[]): void {
		const key = scope ? JSON.stringify(scope) : null;
		if (key === this.scope) return;
		this.scope = key; this.sources.clear();
		if (!scope) return;
		for (const raw of entries) {
			const entry = raw as { type?: unknown; customType?: unknown; data?: Record<string, unknown> };
			const data = entry?.data;
			if (entry?.type !== 'custom' || entry.customType !== COMMAND_PREEMPT_ENTRY || !data || data.version !== 1 ||
				data.nativeSessionId !== scope.nativeSessionId || data.connectionId !== scope.connectionId ||
				data.sessionId !== scope.sessionId || data.attachmentId !== scope.attachmentId ||
				typeof data.sourceMessageId !== 'string' || !uuid.test(data.sourceMessageId)) continue;
			if (data.phase === 'canonical_received') { this.sources.delete(data.sourceMessageId); continue; }
			if (data.phase !== undefined && data.phase !== 'abort_requested') continue;
			if (this.sources.size < 1000) this.sources.add(data.sourceMessageId);
		}
	}
	has(source: string): boolean { return this.sources.has(source); }
	request(source: string, scope: CommandOfferScope, append: (type: string, data: unknown) => void): boolean {
		if (this.scope !== JSON.stringify(scope) || !uuid.test(source) || this.has(source) || this.sources.size >= 1000) return false;
		append(COMMAND_PREEMPT_ENTRY, { version: 1, phase: 'abort_requested', ...scope, sourceMessageId: source });
		this.sources.add(source);
		return true;
	}
	/** Retires only the cancellation budget, not an application/execution ACK. */
	received(source: string, scope: CommandOfferScope, append: (type: string, data: unknown) => void): boolean {
		if (this.scope !== JSON.stringify(scope) || !this.sources.has(source)) return false;
		append(COMMAND_PREEMPT_ENTRY, { version: 1, phase: 'canonical_received', ...scope, sourceMessageId: source });
		this.sources.delete(source);
		return true;
	}
}
