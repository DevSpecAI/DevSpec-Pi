import assert from "node:assert/strict";
import { test } from "node:test";
import { isStaleCtxError, safeHasUI, withLiveUi } from "../extensions/core/ctx-guard.ts";

const STALE = new Error(
	"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().",
);

test("isStaleCtxError matches Pi's invalidate message only", () => {
	assert.equal(isStaleCtxError(STALE), true);
	assert.equal(isStaleCtxError(new Error("compact is not available on this context")), false);
	assert.equal(isStaleCtxError("stale after session replacement or reload"), false);
	assert.equal(isStaleCtxError(null), false);
});

test("safeHasUI swallows a stale hasUI getter and rethrows anything else", () => {
	assert.equal(safeHasUI(null), false);
	assert.equal(safeHasUI({ hasUI: true }), true);
	assert.equal(safeHasUI({ hasUI: false }), false);
	assert.equal(
		safeHasUI({
			get hasUI() {
				throw STALE;
			},
		}),
		false,
	);
	assert.throws(
		() =>
			safeHasUI({
				get hasUI() {
					throw new Error("ui exploded");
				},
			}),
		/ui exploded/,
	);
});

test("withLiveUi does not run the body on a stale ctx and does not throw", () => {
	let ran = false;
	withLiveUi(
		{
			get hasUI() {
				throw STALE;
			},
		},
		() => {
			ran = true;
		},
	);
	assert.equal(ran, false);

	withLiveUi({ hasUI: true }, () => {
		ran = true;
	});
	assert.equal(ran, true);

	assert.doesNotThrow(() =>
		withLiveUi({ hasUI: true }, () => {
			throw STALE;
		}),
	);
	assert.throws(
		() =>
			withLiveUi({ hasUI: true }, () => {
				throw new Error("real bug");
			}),
		/real bug/,
	);
});
