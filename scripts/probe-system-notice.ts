#!/usr/bin/env node
/**
 * Validate a captured live poll response against the exact current Pi bond.
 * Usage:
 *   cat poll.json | node --experimental-strip-types scripts/probe-system-notice.ts \
 *     --connection-id <uuid> --agent-name Pi --codename "Amber Hawk" --label "Pi · Amber Hawk"
 *
 * This is a read-only seam: it performs the same strict parser/formatter step
 * without polling, claiming, acknowledging, persisting, or injecting a room.
 */
import { parsePollPayload } from "../extensions/core/remote-payload.ts";
import { formatSystemNoticeMessage, SYSTEM_NOTICE_CUSTOM_TYPE } from "../extensions/core/system-notice.ts";

function args(argv: string[]): Record<string, string> {
	const result: Record<string, string> = {};
	for (let index = 0; index < argv.length; index += 2) {
		const name = argv[index];
		const value = argv[index + 1];
		if (!name?.startsWith("--") || value === undefined) throw new Error("arguments must be --name value pairs");
		result[name.slice(2)] = value;
	}
	return result;
}

const input = args(process.argv.slice(2));
if (!input["connection-id"] || !input["agent-name"] || !input.label) {
	throw new Error("--connection-id, --agent-name, and --label are required");
}
process.stdin.setEncoding("utf8");
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const parsed = parsePollPayload(JSON.parse(raw), {
	connection_id: input["connection-id"],
	agent_name: input["agent-name"] === "null" ? null : input["agent-name"],
	codename: !input.codename || input.codename === "null" ? null : input.codename,
	label: input.label,
});
if (parsed.canonicalState === "invalid") {
	process.stderr.write(`${parsed.canonicalError ?? "invalid system notice payload"}\n`);
	process.exitCode = 1;
} else {
	process.stdout.write(`${JSON.stringify({
		canonical_state: parsed.canonicalState,
		custom_type: SYSTEM_NOTICE_CUSTOM_TYPE,
		system_notice_cursor: parsed.systemNoticeCursor ?? null,
		notice_ids: parsed.systemNotices.map((notice) => notice.notice_id),
		model_message: parsed.systemNotices.length > 0 ? formatSystemNoticeMessage(parsed.systemNotices) : null,
	}, null, 2)}\n`);
}
