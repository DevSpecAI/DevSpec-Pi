import assert from "node:assert/strict";
import { test } from "node:test";
import { beginAssistantSpeechSource, captureAssistantSpeech, hasAssistantSpeech, preflightAssistantSpeech, ProjectionPostQueue, type SpeechAuthoritySnapshot } from "../extensions/core/assistant-speech.ts";

const authority = (): SpeechAuthoritySnapshot => ({
	connectionId: "connection", expectedSessionId: "room", pumpGeneration: 1,
	expectedRuntimeGeneration: "12345678-1234-1234-1234-123456789abc",
	expectedAttachedAt: "2026-09-17T21:09:32.123456Z",
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
	for (const text of ["", " \n\t", "\u200B\u200C\u200D\uFEFF", "\u2060\u200E", "\u034F", "\uFE0F", "\u{E0100}"]) {
		assert.equal(hasAssistantSpeech(text), false);
		assert.equal(captureAssistantSpeech(assistant(text), authority()), null);
	}
	for (const text of ["  👩‍💻\n", "می‌خواهم", "\t**é**  \n", "\u200Bhello\uFEFF", "a\u034Fb", "❤️", "字\u{E0100}"]) {
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
	auth.expectedRuntimeGeneration = "87654321-4321-4321-4321-cba987654321";
	identity.claimToken = "replacement";
	model.modelID = "replacement";
	assert.equal(speech.authority.expectedSessionId, "room");
	assert.equal(speech.authority.expectedRuntimeGeneration, "12345678-1234-1234-1234-123456789abc");
	assert.equal(speech.model?.modelID, "model");
	assert.equal(speech.authority.source.kind, "interaction");
	if (speech.authority.source.kind === "interaction") {
		assert.equal(speech.authority.source.identity.responseId, "response");
		assert.equal("claimToken" in speech.authority.source.identity, false);
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

test("begin pins room, epoch, full attachment stamp, consumed command and model before first output and streaming", async () => {
	const auth = { ...authority(), source: { kind: "command" as const, commandTurnId: "consumed", commandMessageId: "consumed-input" } };
	const model = { providerID: "provider-A", modelID: "model-A" };
	const source = beginAssistantSpeechSource(auth, model);
	const diagnosticSourceId = source.assistantSourceId;
	// Mutation before an assistant start event: provider request is still pending.
	auth.expectedSessionId = "room-B";
	auth.expectedRuntimeGeneration = "87654321-4321-4321-4321-cba987654321";
	auth.expectedAttachedAt = "2026-09-17T21:09:32.999999Z";
	auth.source.commandTurnId = "queued-not-consumed";
	auth.source.commandMessageId = "queued-input";
	model.modelID = "model-B";
	await Promise.resolve();
	// Further mutation during streaming must not become message_end authority.
	auth.expectedSessionId = "room-C";
	model.providerID = "provider-C";
	const captured = source.finalize(assistant("  original room answer 👩‍💻\n"))!;
	assert.equal(captured.assistantSourceId, diagnosticSourceId);
	assert.equal(captured.authority.expectedSessionId, "room");
	assert.equal(captured.authority.expectedRuntimeGeneration, authority().expectedRuntimeGeneration);
	assert.equal(captured.authority.expectedAttachedAt, "2026-09-17T21:09:32.123456Z");
	assert.deepEqual(captured.authority.source, { kind: "command", commandTurnId: "consumed", commandMessageId: "consumed-input" });
	assert.deepEqual(captured.model, { providerID: "provider-A", modelID: "model-A" });
	assert.ok(Object.isFrozen(source));
});

test("same token returns exact captured identity and rejects conflicting raw text without leaking it", () => {
	const source = beginAssistantSpeechSource(authority());
	const captured = source.finalize(assistant(" private raw text \n"))!;
	assert.equal(source.finalize(assistant(" private raw text \n", "error")), captured);
	for (const conflict of ["private raw text", "replacement", "", "\uFE0F"]) {
		assert.throws(() => source.finalize(assistant(conflict)), { message: "Assistant speech source text conflict." });
		assert.equal(source.finalize(assistant(" private raw text \n")), captured);
	}
	const independent = beginAssistantSpeechSource(authority());
	assert.notEqual(independent.finalize(assistant(captured.text))!.assistantSourceId, captured.assistantSourceId);
});

test("non-assistant events do not finalize a source; empty assistant finals seal without bubbles", () => {
	for (const text of ["", " \n", "\u034F\uFE0F\u{E0100}"]) {
		const source = beginAssistantSpeechSource(authority());
		for (const role of ["custom", "user", "toolResult", "system"]) {
			assert.equal(source.finalize({ ...assistant("not speech"), role }), null);
		}
		assert.equal(source.finalize(assistant(text)), null);
		assert.equal(source.finalize(assistant(text)), null);
		assert.throws(() => source.finalize(assistant("later speech needs a new source")), /source text conflict/);
	}
});

test("partial abort is sealed under its original token; subsequent provider work begins a distinct source", () => {
	const first = beginAssistantSpeechSource(authority());
	const partial = first.finalize(assistant("partial 👩‍💻", "aborted"))!;
	const second = beginAssistantSpeechSource({ ...authority(), expectedSessionId: "next-room" });
	assert.notEqual(first.assistantSourceId, second.assistantSourceId);
	const later = second.finalize(assistant("new answer"))!;
	assert.equal(partial.text, "partial 👩‍💻");
	assert.equal(partial.authority.expectedSessionId, "room");
	assert.equal(later.authority.expectedSessionId, "next-room");
});

test("missing scope or invalid server UUID epoch stays unsupported even if current scope later becomes available", () => {
	for (const key of ["expectedSessionId", "expectedRuntimeGeneration", "expectedAttachedAt"] as const) {
		const auth = { ...authority(), [key]: undefined };
		const source = beginAssistantSpeechSource(auth);
		auth[key] = authority()[key];
		const captured = source.finalize(assistant("retained without a grant"))!;
		assert.deepEqual(captured.authority.source, { kind: "unsupported", reason: "missing_scope" });
		assert.equal(captured.authority[key], undefined);
	}
	for (const epoch of ["1", "2026-09-17", " 12345678-1234-1234-1234-123456789abc "]) {
		const source = beginAssistantSpeechSource({ ...authority(), expectedRuntimeGeneration: epoch });
		assert.deepEqual(source.finalize(assistant("retained"))!.authority.source, { kind: "unsupported", reason: "invalid_scope" });
	}
	const uppercase = "ABCDEF01-2345-6789-ABCD-EF0123456789";
	assert.equal(beginAssistantSpeechSource({ ...authority(), expectedRuntimeGeneration: uppercase }).authority.expectedRuntimeGeneration, uppercase);
});

test("two-phase unsupported-origin capture remains speech without a publication grant", () => {
	for (const reason of ["notice_publication_unavailable", "unknown_origin"] as const) {
		const source = beginAssistantSpeechSource({ ...authority(), source: { kind: "unsupported", reason } });
		assert.deepEqual(source.finalize(assistant("real speech"))!.authority.source, { kind: "unsupported", reason });
	}
});

test("source/token JSON excludes capability AND interaction claim tokens even from structurally wider input", () => {
	const auth = { ...authority(), connectionCapability: "ephemeral-secret", accessToken: "other-secret",
		source: { kind: "interaction" as const, identity: {
			attemptId: "attempt", eventId: "event", responseId: "response", claimToken: "private-claim-secret",
		} },
	};
	const model = { providerID: "provider", modelID: "model", connectionCapability: "model-secret" };
	const source = beginAssistantSpeechSource(auth, model);
	const captured = source.finalize(assistant("retained text"))!;
	for (const value of [source, captured]) {
		assert.doesNotMatch(JSON.stringify(value), /ephemeral-secret|other-secret|model-secret|private-claim-secret|connectionCapability|accessToken|claimToken/);
		assert.deepEqual(value.authority.source, { kind: "interaction", identity: {
			attemptId: "attempt", eventId: "event", responseId: "response",
		} });
	}
});

test("preflight accepts exactly 100000 code points; astral and combining text count code points, not UTF16 or graphemes", () => {
	for (const text of ["a".repeat(100_000), "😀".repeat(100_000), "é".repeat(50_000)]) {
		const result = preflightAssistantSpeech(text);
		assert.equal(result.status, "within_budget");
		assert.equal(result.codePoints, 100_000);
		assert.equal(result.jsonTextBytes, Buffer.byteLength(JSON.stringify(text), "utf8"));
		assert.equal(preflightAssistantSpeech(text + "a").status, "over_budget");
	}
	assert.deepEqual(preflightAssistantSpeech("a".repeat(99_999)), { status: "within_budget", codePoints: 99_999, jsonTextBytes: 100_001 });
	assert.equal(preflightAssistantSpeech("😀".repeat(100_000)).jsonTextBytes, 400_002);
});

test("preflight enforces exact 512000 JSON-encoded UTF8 bytes including escapes and surrounding quotes", () => {
	// Each control character encodes as six ASCII bytes; source still <100k code points.
	const atBound = "\u0001".repeat(85_333); // 511998 escaped bytes + two quotes
	assert.deepEqual(preflightAssistantSpeech(atBound), { status: "within_budget", codePoints: 85_333, jsonTextBytes: 512_000 });
	assert.deepEqual(preflightAssistantSpeech(atBound + "a"), { status: "over_budget", codePoints: 85_334, jsonTextBytes: 512_001 });
	assert.equal(preflightAssistantSpeech(atBound.slice(1)).status, "within_budget");
	for (const [text, bytes] of [['"\\\n\t', 10], ["👩‍💻", 13], ["é", 5], ["字\u{E0100}", 9]] as const) {
		assert.equal(preflightAssistantSpeech(text).jsonTextBytes, bytes);
	}
});

test("budget rejection retains whole frozen source; preflight never claims sent/stored or authorizes unsupported speech", () => {
	for (const text of ["a".repeat(100_001), "\u0001".repeat(85_334)]) {
		const source = beginAssistantSpeechSource(authority());
		const captured = source.finalize(assistant(text))!;
		const result = preflightAssistantSpeech(captured.text);
		assert.equal(result.status, "over_budget");
		assert.equal(captured.text, text);
		assert.equal(source.finalize(assistant(text)), captured);
		assert.deepEqual(Object.keys(result).sort(), ["codePoints", "jsonTextBytes", "status"]);
	}
	const unsupported = beginAssistantSpeechSource({ ...authority(), expectedRuntimeGeneration: undefined }).finalize(assistant("small"))!;
	assert.equal(preflightAssistantSpeech(unsupported.text).status, "within_budget");
	assert.deepEqual(unsupported.authority.source, { kind: "unsupported", reason: "missing_scope" });
});
