/** Conversation-owned project intent, separate from committable folder defaults. */
export const PROJECT_CHOICE_ENTRY = "devspec-project-choice-v1";
export interface ProjectCandidate {
	id: string;
	name: string;
	organization?: { id: string; name: string };
}
export interface ProjectChoice {
	version: 1;
	endpoint: string;
	project: ProjectCandidate;
	source: string;
}
export interface ProjectChoiceRequired {
	version: 1;
	status: "choice_required";
	reason: string;
	candidates: ProjectCandidate[];
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function readProjectCandidate(value: unknown): ProjectCandidate | null {
	const row = object(value);
	if (!row || typeof row.id !== "string" || !UUID.test(row.id) || typeof row.name !== "string") return null;
	const org = object(row.organization);
	return { id: row.id, name: row.name, ...(org && typeof org.id === "string" && UUID.test(org.id) && typeof org.name === "string"
		? { organization: { id: org.id, name: org.name } } : {}) };
}

/** Read structured MCP data or its JSON text equivalent, never English error prose. */
export function projectResultData(raw: unknown): Record<string, unknown> | null {
	const row = object(raw);
	if (!row) return null;
	if (object(row.structuredContent)) return object(row.structuredContent);
	if (Array.isArray(row.content)) for (const block of row.content) {
		const text = object(block);
		if (text?.type !== "text" || typeof text.text !== "string") continue;
		try { const parsed = object(JSON.parse(text.text)); if (parsed) return parsed; } catch { /* legacy plain message */ }
	}
	return null;
}
export function readProjectChoiceRequired(raw: unknown): ProjectChoiceRequired | null {
	const data = projectResultData(raw);
	const selection = object(data?.project_selection);
	if (data?.code !== "project_choice_required" || selection?.version !== 1 || selection.status !== "choice_required" || !Array.isArray(selection.candidates)) return null;
	const candidates = selection.candidates.map(readProjectCandidate);
	if (candidates.some(p => !p || !p.organization)) return null;
	return { version: 1, status: "choice_required", reason: String(selection.reason ?? "project_required"), candidates: candidates as ProjectCandidate[] };
}
export function projectFromRegistration(data: Record<string, unknown>, endpoint: string, fallback?: ProjectCandidate): ProjectChoice | null {
	const selection = object(data.project_selection);
	const project = selection?.version === 1 && selection.status === "resolved" ? readProjectCandidate(selection.project) : null;
	const id = typeof data.project_id === "string" && UUID.test(data.project_id) ? data.project_id : null;
	if (!id || (project && project.id !== id)) return null;
	return { version: 1, endpoint, project: project ?? (fallback?.id === id ? fallback : { id, name: id }), source: typeof selection?.source === "string" ? selection.source : "conversation" };
}

interface ChoiceStore { localId: string | null; choice: ProjectChoice | null; launchConsumed: boolean; error: string | null }
const KEY = "__devspecPiConversationProject";
function store(): ChoiceStore {
	const global = globalThis as unknown as Record<string, ChoiceStore | undefined>;
	return global[KEY] ??= { localId: null, choice: null, launchConsumed: false, error: null };
}
export function getProjectChoice(localId?: string): ProjectChoice | null {
	return localId && store().localId !== localId ? null : store().choice;
}
export function consumeProjectLaunchFlag(): boolean {
	const first = !store().launchConsumed;
	store().launchConsumed = true;
	return first;
}
export function setProjectChoice(localId: string, choice: ProjectChoice | null): void {
	store().localId = localId; store().choice = choice; store().error = null;
}
export function blockProjectChoice(localId: string, error: string): void {
	store().localId = localId; store().error = error;
}
export function restoreProjectChoice(entries: readonly unknown[], localId: string, endpoint: string): ProjectChoice | null {
	let restored: ProjectChoice | null = null;
	for (const entry of entries) {
		const row = object(entry);
		if (row?.type !== "custom" || row.customType !== PROJECT_CHOICE_ENTRY) continue;
		const data = object(row.data);
		const project = readProjectCandidate(data?.project);
		if (data?.version === 1 && data.endpoint === endpoint && project && typeof data.source === "string") {
			restored = { version: 1, endpoint, project, source: data.source };
		}
	}
	setProjectChoice(localId, restored);
	return restored;
}
export function hasConversationProjectScope(): boolean { return Boolean(store().choice || store().error); }
export function conversationScope(args: Record<string, unknown>, endpoint: string): Record<string, unknown> {
	if (store().error && !args.project_id) throw new Error(store().error!);
	const choice = getProjectChoice();
	// Discovery is still account-wide; explicit/entity identifiers are validated server-side.
	return choice?.endpoint === endpoint && !args.project_id ? { ...args, project_id: choice.project.id } : args;
}
const terminalText = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
export function projectLabel(project: ProjectCandidate): string {
	return `${terminalText(project.name)} — ${terminalText(project.organization?.name ?? "organisation unavailable")} · ${project.id}`;
}
export function matchingProjects(projects: readonly ProjectCandidate[], selector: string): ProjectCandidate[] {
	const value = selector.trim().toLowerCase();
	const ids = projects.filter(p => p.id.toLowerCase() === value);
	return ids.length ? ids : projects.filter(p => p.name.toLowerCase() === value);
}

/** Extract only our flag, leaving the existing room parser's vocabulary untouched. */
export function projectRemoteArgs(input: string): { selector?: string; remaining: string; error?: string } {
	const tokens: string[] = [];
	let current = "", quote = "", inToken = false;
	for (const char of input.trim()) {
		if (quote) { if (char === quote) quote = ""; else current += char; inToken = true; }
		else if (char === '"' || char === "'") { quote = char; inToken = true; }
		else if (/\s/.test(char)) { if (inToken) { tokens.push(current); current = ""; inToken = false; } }
		else { current += char; inToken = true; }
	}
	if (quote) return { remaining: "", error: "Close the quoted project name before connecting." };
	if (inToken) tokens.push(current);
	let selector: string | undefined;
	const remaining: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i] === "--project" || tokens[i] === "--devspec-project") {
			if (selector !== undefined || !tokens[i + 1]?.trim() || tokens[i + 1]!.startsWith("--")) return { remaining: "", error: "Pass one project name or ID after --project." };
			selector = tokens[++i];
		} else remaining.push(tokens[i]!);
	}
	return { selector, remaining: remaining.join(" ") };
}
