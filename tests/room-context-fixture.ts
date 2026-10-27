import { canonicalPoll } from "./canonical-ingress-fixture.ts";

export function roomPoll(options: Parameters<typeof canonicalPoll>[0] = {}) {
	const p = canonicalPoll({ senderStyleNegotiated: true, context: canonicalPoll().ingress.context, ...options });
	const rows = [...p.ingress.commands, ...Object.values(p.ingress.context).flat()] as Array<{ message_id: string }>;
	return { ...p, ingress: { ...p.ingress, contract_version: "1.6.0", policy_version: "2026-09-24.1", window: { ...p.ingress.window, policy_version: "2026-09-24.1" },
		room_context: { version: 1, messages: rows.map(r => ({ message_id: r.message_id, state: "final", addressee: { kind: "room" }, attachments: [] as unknown[] })), coverage: p.ingress.window.source_window.end ? { through: p.ingress.window.source_window.end, eligible_count: rows.length, deleted_count: 0, open_message_ids: [] as string[] } : null },
	} };
}
