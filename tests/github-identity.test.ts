/**
 * The GitHub identity link DevSpec offers at connect (ADR "Protecting intent"
 * §14, server c45f75d4) is shown to the person, and only as a web link: the
 * register_connection payload is server data, and a link a person is asked to
 * open must never be some other kind of URL.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { githubIdentityNotice } from "../extensions/core/github-identity.ts";

test("a link DevSpec says is needed is shown to the person; a linked account or no prompt shows nothing", () => {
	const url = "https://devspecstaging.com/api/git/github/identity?returnTo=%2Fsettings%2Faccount";
	const notice = githubIdentityNotice({ status: "link_required", url, message: "Ask the person to link their GitHub account" });
	assert.ok(notice?.includes(url));
	assert.match(notice!, /DevSpec keeps no access to your account/);
	assert.equal(githubIdentityNotice({ status: "linked", logins: ["octocat"] }), null);
	assert.equal(githubIdentityNotice(undefined), null);
	assert.equal(githubIdentityNotice({ status: "link_required" }), null);
});

test("only a web link is offered to be opened", () => {
	for (const url of ["javascript:alert(1)", "file:///etc/passwd", "http://devspec.example/identity", "not a url"]) {
		assert.equal(githubIdentityNotice({ status: "link_required", url }), null, url);
	}
	assert.ok(githubIdentityNotice({ status: "link_required", url: "http://localhost:3000/api/git/github/identity" }));
});
