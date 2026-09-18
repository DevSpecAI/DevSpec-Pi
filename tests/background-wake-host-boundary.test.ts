import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSession, InteractiveMode } from "@earendil-works/pi-coding-agent";

/** Qualification of installed host methods, not a proposed queue-manipulating adapter. */
test("installed TUI ctx.abort moves owner input accepted during admission await out of the execution queue", async () => {
	let abortHandler: (() => void) | undefined;
	let aborts = 0;
	let editor = "";
	const agentQueue: string[] = [];
	const agent = { clearAllQueues: () => { agentQueue.length = 0; }, abort: () => { aborts++; } };
	const session = {
		_steeringMessages: [] as string[], _followUpMessages: [] as string[], agent,
		_emitQueueUpdate: () => {},
		clearQueue: AgentSession.prototype.clearQueue,
		bindExtensions: async (options: { abortHandler: () => void }) => { abortHandler = options.abortHandler; },
		resourceLoader: { getThemes: () => ({ themes: [] }) }, extensionRunner: {},
	};
	const methods = InteractiveMode.prototype as unknown as {
		bindCurrentSessionExtensions: (this: unknown) => Promise<void>;
		clearAllQueues: (this: unknown) => unknown;
		restoreQueuedMessagesToEditor: (this: unknown, options: unknown) => unknown;
	};
	const host = {
		session, agent, compactionQueuedMessages: [],
		createExtensionUIContext: () => ({}),
		setupAutocompleteProvider: () => {}, setupExtensionShortcuts: () => {},
		showLoadedResources: () => {}, showStartupNoticesIfNeeded: () => {},
		updatePendingMessagesDisplay: () => {},
		editor: { getText: () => editor, setText: (value: string) => { editor = value; } },
		clearAllQueues: methods.clearAllQueues,
		restoreQueuedMessagesToEditor: methods.restoreQueuedMessagesToEditor,
	};
	await methods.bindCurrentSessionExtensions.call(host);
	assert.ok(abortHandler, "capture the ACTUAL installed TUI extension abort binding");
	let release!: () => void;
	const admission = new Promise<void>(resolve => { release = resolve; });
	const recap = (async () => { await admission; abortHandler!(); })();
	// Native steering is accepted while the exact source-less CAS is in flight.
	session._steeringMessages.push("new owner instruction");
	agentQueue.push("new owner instruction");
	release(); await recap;
	assert.equal(aborts, 1);
	assert.deepEqual(agentQueue, [], "queued owner execution is removed, despite a current recap fence");
	assert.deepEqual(session._steeringMessages, []);
	assert.equal(editor, "new owner instruction", "text survives only as unsent editor text, not accepted delivery");
});
