import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join, dirname, relative, sep } from "node:path";
import { resolveEndpoint, resolveToken } from "./auth-store.ts";
import { callDevspec } from "./client.ts";
import { getBond } from "./bond-state.ts";
import { resolveProjectPinFile, forgetProjectPin, pinTargetDir, writeProjectPin } from "./project-scope.ts";
import {
	PROJECT_CHOICE_ENTRY, getProjectChoice, setProjectChoice, restoreProjectChoice, consumeProjectLaunchFlag, blockProjectChoice,
	projectLabel, matchingProjects, readProjectCandidate, projectResultData,
	type ProjectCandidate, type ProjectChoice, type ProjectChoiceRequired,
} from "./project-choice.ts";

export interface ProjectBondOutcome {
	ok: boolean; error?: string; errorKind?: "auth" | "api"; codename?: string; attached?: boolean; cancelled?: boolean;
	projectChoice?: ProjectChoiceRequired;
}
export interface ProjectSelectionDependencies {
	attempt(ctx: ExtensionContext, room?: string, project?: ProjectCandidate): Promise<ProjectBondOutcome>;
	stop(ctx: ExtensionContext): Promise<void>;
}

/** Native UI only; selection and transport logic remain testable without a model. */
export function installProjectSelection(pi: ExtensionAPI, deps: ProjectSelectionDependencies) {
	pi.registerFlag("devspec-project", { type: "string", description: "Use a DevSpec project name or ID for this local conversation." });
	let connecting = false;
	let explicitConnect = false;
	const CONNECT_ONCE_ENTRY = "devspec-project-connect-once-v1";

	function persist(ctx: ExtensionContext, choice: ProjectChoice) {
		const previous = getProjectChoice();
		setProjectChoice(ctx.sessionManager.getSessionId(), choice);
		if (JSON.stringify(previous) !== JSON.stringify(choice)) pi.appendEntry(PROJECT_CHOICE_ENTRY, choice);
		ctx.ui.setStatus("devspec-project", `DevSpec: ${projectLabel(choice.project)} (${choice.source})`);
	}

	async function pick(ctx: ExtensionContext, candidates: ProjectCandidate[], selector?: string): Promise<ProjectCandidate | null> {
		const matches = selector ? matchingProjects(candidates, selector) : candidates;
		if (selector && matches.length === 1) return matches[0]!;
		if (matches.length === 0) throw new Error(selector ? `No accessible project matches “${selector}”. Use an exact name or full project ID.` : "No accessible DevSpec projects are available.");
		if (ctx.mode !== "tui") throw new Error(`Choose a project explicitly with --devspec-project <id>: ${matches.map(projectLabel).join("; ")}`);
		const labels = matches.map(projectLabel);
		const choice = await ctx.ui.select("Which DevSpec project should this conversation use?", [...labels, "Continue without connecting"]);
		const index = labels.indexOf(choice ?? "");
		return index < 0 ? null : matches[index]!;
	}

	async function accessible(ctx: ExtensionContext, selector?: string): Promise<ProjectCandidate | null> {
		const auth = await resolveToken();
		if (!auth) throw new Error("Not connected to DevSpec — /devspec.login first.");
		const raw = await callDevspec(auth.token, "list_projects", {}, { lane: "work" });
		const data = projectResultData(raw);
		if (!Array.isArray(data?.projects)) throw new Error("DevSpec did not return a project list. Please retry.");
		const projects = data.projects.map(readProjectCandidate);
		if (projects.some(p => !p)) throw new Error("DevSpec returned an invalid project choice. Please retry.");
		return pick(ctx, projects as ProjectCandidate[], selector);
	}

	async function remember(ctx: ExtensionContext, project: ProjectCandidate) {
		if (ctx.mode !== "tui") throw new Error("Remembering a folder default requires an interactive confirmation. Conversation-only selection remains active.");
		const effective = await resolveProjectPinFile(ctx.cwd);
		const target = join(pinTargetDir(ctx.cwd), ".devspec", "project.json");
		if (effective && effective.path !== target) {
			const nested = relative(pinTargetDir(ctx.cwd), dirname(dirname(effective.path)));
			if (nested && nested !== ".." && !nested.startsWith(`..${sep}`)) {
				throw new Error(`A nearer folder default at ${effective.path} would override ${target}. Manage that file explicitly; this conversation's choice is unchanged.`);
			}
		}
		const consent = await ctx.ui.confirm("Remember for this folder?", `${projectLabel(project)}\nWrite ${target}${effective ? `\nCurrent effective default: ${effective.projectId} at ${effective.path}` : ""}\nThis is shared folder configuration and may be committed. It affects future connections, not existing conversations. A unique remote match still wins over a pin.`);
		if (!consent) return;
		// The user confirmed this effective default; don't overwrite a change made while the dialog was open.
		const current = await resolveProjectPinFile(ctx.cwd);
		if (JSON.stringify(current) !== JSON.stringify(effective)) throw new Error("The folder default changed. Review it again before replacing it.");
		const written = await writeProjectPin(ctx.cwd, project.id, project.name);
		ctx.ui.notify(`Folder default saved to ${written.path}. Existing conversations are unchanged.`, "info");
	}

	async function offerRemember(ctx: ExtensionContext, project: ProjectCandidate) {
		if (ctx.mode !== "tui") return;
		const mode = await ctx.ui.select("How should DevSpec remember this choice?", ["Use for this conversation", "Remember for this folder"]);
		if (mode === "Remember for this folder") await remember(ctx, project);
	}

	async function connect(ctx: ExtensionContext, room?: string, selector?: string): Promise<ProjectBondOutcome> {
		if (connecting) return { ok: false, error: "A DevSpec connection is already being selected. Finish that choice first.", errorKind: "api" };
		connecting = true;
		try {
			let project: ProjectCandidate | undefined;
			if (selector !== undefined) {
				const selected = await accessible(ctx, selector);
				if (!selected) return { ok: false, cancelled: true, error: "Project selection cancelled; not connected." };
				project = selected;
				const current = getProjectChoice()?.project.id ?? getBond()?.projectId;
				if (current && current !== project.id) return { ok: false, error: "This conversation already uses another project. Use /devspec.project choose to start a fresh conversation.", errorKind: "api" };
			}
			let outcome = await deps.attempt(ctx, room, project);
			if (!outcome.ok && outcome.projectChoice && !project) {
				const selected = await pick(ctx, outcome.projectChoice.candidates);
				if (!selected) return { ok: false, cancelled: true, error: "Project selection cancelled; not connected." };
				outcome = await deps.attempt(ctx, room, selected);
				if (outcome.ok) await offerRemember(ctx, selected);
			}
			return outcome;
		} catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err), errorKind: "api" }; }
		finally { connecting = false; }
	}

	/** Runs before auto-bond, including in headless mode; never prompts there. */
	async function prepare(ctx: ExtensionContext): Promise<boolean> {
		try {
			const endpoint = await resolveEndpoint();
			const entries = ctx.sessionManager.getEntries();
			const intent = entries.filter(entry => entry.type === "custom" && entry.customType === CONNECT_ONCE_ENTRY).at(-1);
			explicitConnect = intent?.type === "custom" && (intent.data as { requested?: unknown } | undefined)?.requested === true;
			if (explicitConnect) pi.appendEntry(CONNECT_ONCE_ENTRY, { requested: false });
			const choice = restoreProjectChoice(entries, ctx.sessionManager.getSessionId(), endpoint);
			if (!choice && entries.some(entry => entry.type === "custom" && entry.customType === PROJECT_CHOICE_ENTRY)) {
				throw new Error("This conversation's saved project cannot be restored for this DevSpec endpoint. Start a fresh local conversation.");
			}
			ctx.ui.setStatus("devspec-project", choice ? `DevSpec: ${projectLabel(choice.project)} (${choice.source})` : undefined);
			const selector = consumeProjectLaunchFlag() ? pi.getFlag("devspec-project") : undefined;
			if (selector !== undefined) {
				if (typeof selector !== "string" || !selector.trim()) throw new Error("--devspec-project requires an exact project name or ID.");
				const selected = await accessible(ctx, selector);
				if (!selected) return false;
				if (choice && choice.project.id !== selected.id) throw new Error("This resumed conversation belongs to another project. Start a new Pi conversation without --session/--resume to choose another project.");
				persist(ctx, { version: 1, endpoint, project: selected, source: "explicit" });
			}
			return true;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			blockProjectChoice(ctx.sessionManager.getSessionId(), message);
			ctx.ui.notify(message, "error"); return false;
		}
	}

	pi.registerCommand("devspec.project", {
		description: "Show or choose this conversation's project; remember or forget a folder default. Usage: /devspec.project [status|choose|remember|forget|<name-or-id>]",
		handler: async (args, ctx) => {
			try {
				const command = args.trim();
				const current = getProjectChoice();
				if (!command || command === "status") {
					const pin = await resolveProjectPinFile(ctx.cwd);
					ctx.ui.notify(`${current ? projectLabel(current.project) + `\nSource: ${current.source}` : "No conversation project selected."}\n${getBond() ? "Connected" : "Not connected"}\nFolder default: ${pin ? `${pin.projectId} at ${pin.path}` : "none"}\n/devspec.project choose | remember | forget`, "info");
					return;
				}
				if (command === "remember") {
					if (!current) throw new Error("Choose a project for this conversation first: /devspec.project choose");
					await remember(ctx, current.project); return;
				}
				if (command === "forget") {
					const pin = await resolveProjectPinFile(ctx.cwd);
					if (!pin) { ctx.ui.notify("No usable folder default to forget.", "info"); return; }
					if (ctx.mode !== "tui") throw new Error(`Forgetting requires interactive confirmation of ${pin.path}.`);
					if (!await ctx.ui.confirm("Forget this folder default?", `${pin.projectId}\nRemove ${pin.path}\nThis file may be shared or committed. Existing conversations keep their project.`)) return;
					await forgetProjectPin(pin);
					const next = await resolveProjectPinFile(ctx.cwd);
					ctx.ui.notify(`Folder default removed. Existing conversations are unchanged.${next ? ` Another inherited default remains: ${next.projectId} at ${next.path}` : ""}`, "info"); return;
				}
				if (!ctx.isIdle()) throw new Error("Finish the current turn before choosing another project.");
				const selector = (command.startsWith('"') && command.endsWith('"')) || (command.startsWith("'") && command.endsWith("'")) ? command.slice(1, -1) : command;
				const selected = await accessible(ctx, command === "choose" ? undefined : selector);
				if (!selected) return;
				const currentId = current?.project.id ?? getBond()?.projectId;
				if (currentId && currentId !== selected.id) {
					if (ctx.mode !== "tui") throw new Error(`Start a fresh Pi conversation with --devspec-project ${selected.id}.`);
					if (!await ctx.ui.confirm("Start a fresh conversation?", `${projectLabel(selected)}\nThe previous conversation's model context will not be carried across. Its transcript is kept.`)) return;
					const seed: ProjectChoice = { version: 1, endpoint: await resolveEndpoint(), project: selected, source: "explicit" };
					await deps.stop(ctx);
					// The replacement runtime owns connection setup. Never resume an old
					// extension graph's pump using a new session context.
					const switched = await ctx.newSession({ setup: async manager => {
						manager.appendCustomEntry(PROJECT_CHOICE_ENTRY, seed);
						manager.appendCustomEntry(CONNECT_ONCE_ENTRY, { requested: true });
					} });
					if (switched.cancelled) {
						const restored = await connect(ctx);
						if (!restored.ok) ctx.ui.notify(restored.error ?? "Could not reconnect the previous conversation.", "error");
					}
					return;
				}
				if (!getBond()) {
					const result = await deps.attempt(ctx, undefined, selected);
					if (!result.ok) throw new Error(result.error ?? "Could not connect.");
				}
				await offerRemember(ctx, selected);
			} catch (err) { ctx.ui.notify(err instanceof Error ? err.message : String(err), "error"); }
		},
	});
	return { prepare, connect, persist, resolve: accessible, consumeExplicitConnect: () => { const requested = explicitConnect; explicitConnect = false; return requested; } };
}
