import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";

test("Pi package discovery and login do not install an independent launcher", () => {
  for (const relative of ["../launcher", "../extensions/devspec-launcher.ts", "../extensions/core/launcher-status.ts"]) {
    assert.equal(fs.existsSync(new URL(relative, import.meta.url)), false, relative);
  }
  const auth = fs.readFileSync(new URL("../extensions/devspec-auth.ts", import.meta.url), "utf8");
  assert.doesNotMatch(auth, /installBundledLauncher|devspec-launcher|DEVSPEC_LAUNCHER_DISABLED/);
  assert.match(auth, /await saveAuth/);
  assert.match(auth, /pi.registerCommand\("devspec.login"/);
  assert.ok(fs.existsSync(new URL("../extensions/devspec-remote.ts", import.meta.url)));
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.pi.extensions.includes("./extensions"));
  assert.doesNotMatch(pkg.scripts.test, /launcher-test-env/);
  // The DevSpec Launcher is not offered to customers until it has a published
  // install path, so the package README does not send readers to it.
  assert.doesNotMatch(fs.readFileSync(new URL("../README.md", import.meta.url), "utf8"), /launcher/i);
});
