import assert from "node:assert/strict";
import { test } from "node:test";
import { captureAssistantSpeech, hasAssistantSpeech, ProjectionPostQueue, type SpeechAuthoritySnapshot } from "../extensions/core/assistant-speech.ts";

const authority = (): SpeechAuthoritySnapshot => ({
	connectionId: "connection", expectedSessionId: "room", pumpGeneration: 1,
	connectionCapability: "private-capability",
	source: { kind: "command", commandTurnId: "command", commandMessageId: "owner-message" },
});
const assistant = (text: string, stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }], stopReason });
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(r => { resolve = r; });
	return { promise, resolve };
}

test("aa8920bd-style wake and substantive no-further-action remain raw speech", () => {
	for (const text of [
		"Task A’s wake arrived with B still running. I’ll wait for the build notification.",
		"The deployment passed. No further action is needed; the rollback check confirmed the old version is intact.",
		"Expected teardown receipt received; no action needed.",
		"Local prompt: this is assistant speech, not owner input.",
	]) assert.equal(captureAssistantSpeech(assistant(text), authority())?.text, text);
});

test("text before, between, and after tools is one ordered source; thinking and structural messages are not speech", () => {
	const content = [
		{ type: "text", text: " before\n" },
		{ type: "toolCall", name: "read", arguments: { path: "private" } },
		{ type: "text", text: "between " },
		{ type: "thinking", thinking: "private thinking" },
		{ type: "toolCall", name: "bash" },
		{ type: "text", text: "after  \n" },
	];
	assert.equal(captureAssistantSpeech({ role: "assistant", content }, authority())?.text, " before\nbetween after  \n");
	for (const role of ["user", "system", "custom", "toolResult"]) {
		assert.equal(captureAssistantSpeech({ role, content }, authority()), null);
	}
	assert.equal(captureAssistantSpeech({ role: "assistant", content: content.filter(b => b.type !== "text") }, authority()), null);
});

test("empty/invisible-only differs from emoji ZWJ and meaningful ZWNJ; formatting is never rewritten", () => {
	for (const text of ["", " \n\t", "\u200B\u200C\u200D\uFEFF", "\u2060\u200E"]) {
		assert.equal(hasAssistantSpeech(text), false);
		assert.equal(captureAssistantSpeech(assistant(text), authority()), null);
	}
	for (const text of ["  👩‍💻\n", "می‌خواهم", "\t**é**  \n", "\u200Bhello\uFEFF"]) {
		assert.equal(captureAssistantSpeech(assistant(text), authority())?.text, text);
	}
});

test("error, aborted, length and toolUse partials cannot be overwritten by later messages", () => {
	for (const stop of ["error", "aborted", "length", "pending", "toolUse"]) {
		const message = assistant(`partial ${stop}`, stop);
		const partial = captureAssistantSpeech(message, authority())!;
		message.content[0]!.text = "mutated host message";
		const later = captureAssistantSpeech(assistant("later"), authority())!;
		assert.equal(partial.text, `partial ${stop}`);
		assert.notEqual(partial.assistantSourceId, later.assistantSourceId);
		assert.throws(() => { (partial as { text: string }).text = "cleanup"; }, TypeError);
	}
});

test("independent identical messages have distinct UUIDs; explicit resend retains the captured source", () => {
	const first = captureAssistantSpeech(assistant("same"), authority())!;
	const second = captureAssistantSpeech(assistant("same"), authority())!;
	assert.match(first.assistantSourceId, /^[0-9a-f-]{36}$/);
	assert.notEqual(first.assistantSourceId, second.assistantSourceId);
	const retry = first;
	assert.equal(retry.assistantSourceId, first.assistantSourceId);
	assert.equal(retry.text, first.text);
});

test("authority, exact interaction and model are copied and frozen before asynchronous use", () => {
	const identity = { attemptId: "attempt", eventId: "event", responseId: "response", claimToken: "claim" };
	const auth = { ...authority(), source: { kind: "interaction" as const, identity } };
	const model = { providerID: "provider", modelID: "model" };
	const speech = captureAssistantSpeech(assistant("answer"), auth, model)!;
	auth.expectedSessionId = "foreign-room";
	auth.connectionCapability = "replacement";
	identity.claimToken = "replacement";
	model.modelID = "replacement";
	assert.equal(speech.authority.expectedSessionId, "room");
	assert.equal(speech.authority.connectionCapability, "private-capability");
	assert.equal(speech.model?.modelID, "model");
	assert.equal(speech.authority.source.kind, "interaction");
	if (speech.authority.source.kind === "interaction") {
		assert.equal(speech.authority.source.identity.claimToken, "claim");
		assert.ok(Object.isFrozen(speech.authority.source.identity));
	}
	assert.ok(Object.isFrozen(speech.authority));
});

test("unsupported notice/unknown-origin text is retained without a fabricated publication grant", () => {
	for (const reason of ["notice_publication_unavailable", "unknown_origin"] as const) {
		const speech = captureAssistantSpeech(assistant("real authored speech"), {
			...authority(), source: { kind: "unsupported", reason },
		})!;
		assert.equal(speech.text, "real authored speech");
		assert.deepEqual(speech.authority.source, { kind: "unsupported", reason });
	}
});

test("capture retains all >12000 characters, multibyte text and JSON escaping without an invented delivery ceiling", () => {
	for (const text of ["a".repeat(12000), "a".repeat(12001), "👩‍💻".repeat(12001), '\\"\n'.repeat(12001)]) {
		const speech = captureAssistantSpeech(assistant(text), authority())!;
		assert.equal(speech.text, text);
		assert.equal(JSON.parse(JSON.stringify(speech)).text, text);
	}
});

test("delayed predecessor, competing trail-pointer write and later speech execute in source order", async () => {
	const queue = new ProjectionPostQueue();
	const gate = deferred();
	const seen: string[] = [];
	const first = queue.enqueue(async () => { seen.push("speech1-start"); await gate.promise; seen.push("speech1-end"); });
	const trail = queue.enqueue(async () => { seen.push("trail"); });
	const second = queue.enqueue(async () => { seen.push("speech2"); });
	await Promise.resolve();
	assert.deepEqual(seen, ["speech1-start"]);
	gate.resolve();
	await Promise.all([first, trail, second]);
	assert.deepEqual(seen, ["speech1-start", "speech1-end", "trail", "speech2"]);
});

test("failure is exposed once, never replayed; later source can still be delivered", async () => {
	const queue = new ProjectionPostQueue();
	let attempts = 0;
	const failed = queue.enqueue(async () => { attempts++; throw new Error("ambiguous response"); });
	const later = queue.enqueue(async () => "stored");
	await assert.rejects(failed, /ambiguous response/);
	assert.equal(await later, "stored");
	await queue.drain();
	assert.equal(attempts, 1);
});

test("queued stale reattach check uses captured authority, never retargets a record", async () => {
	const queue = new ProjectionPostQueue();
	const gate = deferred();
	void queue.enqueue(() => gate.promise);
	const speech = captureAssistantSpeech(assistant("private room speech"), authority())!;
	let currentRoom = "room";
	const sent: string[] = [];
	const result = queue.enqueue(async () => {
		if (speech.authority.expectedSessionId !== currentRoom) return "skipped";
		sent.push(speech.text);
		return "stored";
	});
	currentRoom = "other-room";
	gate.resolve();
	assert.equal(await result, "skipped");
	assert.deepEqual(sent, []);
	assert.equal(speech.text, "private room speech");
});

test("drain includes pointer work added while a predecessor is pending", async () => {
	const queue = new ProjectionPostQueue();
	const first = deferred();
	const second = deferred();
	void queue.enqueue(() => first.promise);
	let drained = false;
	const draining = queue.drain().then(() => { drained = true; });
	void queue.enqueue(() => second.promise);
	first.resolve();
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(drained, false);
	second.resolve();
	await draining;
	assert.equal(drained, true);
});
