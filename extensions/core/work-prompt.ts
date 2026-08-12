/**
 * DevSpec Pi — /devspec.work kickoff prompt builder (pure, unit-tested).
 *
 * The command validates and resolves the item; this builds the user message
 * that kicks off the work turn. The prompt (not the command) drives the
 * claim, because claim guards (possible_conflict, existing claims) need the
 * model's judgment in context — the command's job is validation, not side
 * effects.
 */

export interface WorkTarget {
	id: string;
	title?: string;
	/** Full item payload (get_action_item / get_next_work_item response). */
	payload: unknown;
	/** True when the payload came from get_next_work_item (queue pick). */
	fromQueue: boolean;
}

function shortId(id: string): string {
	return id.replace(/-/g, "").slice(0, 8);
}

function slugify(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
}

export function suggestBranch(item: WorkTarget): string {
	const slug = item.title ? slugify(item.title) : "";
	return `devspec/${shortId(item.id)}${slug ? `-${slug}` : ""}`;
}

export function buildWorkPrompt(item: WorkTarget): string {
	const branch = suggestBranch(item);
	const source = item.fromQueue
		? "This is the next staged item from the project queue."
		: "This item was chosen explicitly.";
	const payloadJson = JSON.stringify(item.payload, null, 2);

	return [
		`Work DevSpec action item ${item.id}${item.title ? ` — "${item.title}"` : ""}. ${source}`,
		"",
		"Follow the DevSpec workflow:",
		`1. Claim it with claim_work_item (agent_branch: "${branch}", unless the project's branch_prefix says otherwise). If the claim is REJECTED for a possible_conflict or an existing claim, STOP and surface it — do not force past it.`,
		"2. Read the payload below in full — ai_instructions, relevant_memories, relevant_artifacts, review_signals — plus the project_custom_instructions and project_agent_rules returned with the claim. Both instruction tiers are binding.",
		"3. Implement. Push each repo to its own target_branch.",
		`4. End every implementing commit message with [devspec:${item.id}].`,
		"5. After pushing, call record_implementation with the final commit SHA, affected_files, testing_notes, and completion_summary. Act on any own_criteria_follow_through / brief_follow_through in the response, then report \"implemented\" and stop — never mark the item done.",
		"",
		"Item payload:",
		"```json",
		payloadJson,
		"```",
	].join("\n");
}
