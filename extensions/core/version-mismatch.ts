/**
 * What Pi says when DevSpec and this extension no longer agree about something
 * (DevSpec item 39c05c1f). Customers update the extension when they choose, so a
 * newer DevSpec will regularly meet an older Pi. Whatever still matches keeps
 * working; whatever does not degrades on its own and says, in words the person can
 * act on, that updating the extension fixes it.
 */
export const UPDATE_EXTENSION_INSTRUCTION =
	"To fix this, update the DevSpec Pi extension: run `pi update --extensions`, then restart Pi.";

type SchemaNode = Record<string, unknown>;

function asNode(value: unknown): SchemaNode | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as SchemaNode : null;
}

/** The branches a node may take: itself, or each of its anyOf/oneOf alternatives. */
function branches(node: SchemaNode): SchemaNode[] {
	const alternatives = [node.anyOf, node.oneOf].flatMap((list) => Array.isArray(list) ? list.map(asNode).filter((entry): entry is SchemaNode => entry !== null) : []);
	return [node, ...alternatives];
}

/**
 * Find the field a refusal names (a dotted path such as `criteria.0.text`) in Pi's
 * own schema for the tool, and whether Pi lists it as required.
 */
function locateField(schema: SchemaNode | undefined, path: string): { node: SchemaNode; required: boolean } | null {
	if (!schema) return null;
	let current: SchemaNode[] = [schema];
	let required = false;
	for (const segment of path.split(".").filter(Boolean)) {
		const next: SchemaNode[] = [];
		required = false;
		for (const node of current.flatMap(branches)) {
			const properties = asNode(node.properties);
			const property = properties ? asNode(properties[segment]) : null;
			if (property) {
				next.push(property);
				if (Array.isArray(node.required) && node.required.includes(segment)) required = true;
				continue;
			}
			const items = asNode(node.items);
			if (items && /^\d+$/.test(segment)) next.push(items);
		}
		if (next.length === 0) return null;
		current = next;
	}
	return { node: current[0]!, required };
}

function allowedValues(node: SchemaNode): unknown[] | null {
	for (const branch of branches(node)) {
		if (Array.isArray(branch.enum)) return branch.enum;
		if (Object.hasOwn(branch, "const")) return [branch.const];
		const items = asNode(branch.items);
		if (items && Array.isArray(items.enum)) return items.enum;
	}
	return null;
}

function sameValues(left: readonly unknown[], right: readonly unknown[]): boolean {
	const key = (value: unknown) => JSON.stringify(value);
	const a = new Set(left.map(key));
	const b = new Set(right.map(key));
	return a.size === b.size && [...a].every((value) => b.has(value));
}

/**
 * When DevSpec refuses a call, say whether that is because DevSpec's definition of
 * the tool and this extension's no longer agree — and only then. The refusal names
 * the field and the rule it broke; Pi compares that with its own schema for the
 * tool. A call Pi's schema already allowed that the server refuses on the same
 * terms is a version difference; anything else (a value that is simply invalid, a
 * rule only the server can judge) is an ordinary mistake and gets no update hint.
 */
export function toolVersionMismatchNote(toolName: string, refusal: unknown, wireSchema: Record<string, unknown> | undefined): string | null {
	const row = asNode(refusal);
	if (!row || typeof row.code !== "string") return null;
	if (typeof row.tool === "string" && row.tool !== toolName) return null;
	const close = `This is a version difference between DevSpec and this extension, not a mistake in the call. Tell the person: ${UPDATE_EXTENSION_INSTRUCTION}`;
	if (row.code === "unknown_tool") {
		return `DevSpec no longer has the \`${toolName}\` tool, which this version of the DevSpec Pi extension still offers. ${close}`;
	}
	const field = typeof row.field === "string" && row.field ? row.field : null;
	if (!field) return null;
	const mine = locateField(asNode(wireSchema) ?? undefined, field);
	switch (row.code) {
		case "argument_missing":
			// Pi validates its own required fields before sending, so a field DevSpec
			// requires and Pi does not is the only way to arrive here.
			if (mine?.required) return null;
			return `DevSpec now requires \`${field}\` for \`${toolName}\`, which this version of the DevSpec Pi extension does not ask for. ${close}`;
		case "argument_not_allowed": {
			if (!mine || !Array.isArray(row.allowed)) return null;
			const offered = allowedValues(mine.node);
			if (offered && sameValues(offered, row.allowed)) return null;
			return `DevSpec accepts different values for \`${field}\` in \`${toolName}\` than this version of the DevSpec Pi extension offers. ${close}`;
		}
		case "argument_limit_exceeded": {
			if (!mine || typeof row.keyword !== "string" || typeof row.limit !== "number") return null;
			if (mine.node[row.keyword] === row.limit) return null;
			return `DevSpec limits \`${field}\` in \`${toolName}\` differently from this version of the DevSpec Pi extension. ${close}`;
		}
		case "argument_malformed": {
			if (!mine || typeof row.pattern !== "string") return null;
			if (mine.node.pattern === row.pattern) return null;
			return `DevSpec expects \`${field}\` in \`${toolName}\` in a different form from this version of the DevSpec Pi extension. ${close}`;
		}
		default:
			return null;
	}
}

/**
 * What to say when DevSpec sends this Pi a remote message it cannot read — once per
 * distinct reason, not on every retry. Before, Pi only wrote a debug line and
 * retried, so a command sent from a room never arrived and nobody was told why.
 * Pi keeps retrying with the cursor where it was, so a corrected message is still
 * picked up; this only makes the wait visible. The room text is for whoever sent
 * the command, who cannot see Pi's terminal; the reason stays local, because it is
 * Pi's parser talking.
 */
export function unreadableRemoteMessageNotice(
	reason: string | undefined,
	alreadyReported: string | undefined,
): { key: string; local: string; room: string } | null {
	const key = reason?.trim() || "the message did not match any format this extension reads";
	if (key === alreadyReported) return null;
	return {
		key,
		local: `DevSpec sent this Pi a message it cannot read (${key}), so Pi has not acted on it. Pi keeps checking and will act on the message once it can read it. ${UPDATE_EXTENSION_INSTRUCTION}`,
		room: "I couldn't read a message DevSpec sent me, so I haven't acted on it. My DevSpec Pi extension is probably out of date: on the computer I'm running on, run `pi update --extensions`, then restart Pi.",
	};
}
