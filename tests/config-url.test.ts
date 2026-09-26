import assert from "node:assert/strict";
import { test } from "node:test";

// Endpoint resolution reads the environment at call time; start from a clean slate.
delete process.env.DEVSPEC_MCP_URL;
delete process.env.DEVSPEC_ENV;

const {
	CODING_AGENTS_URL,
	DEFAULT_MCP_URL,
	ENV_ENV_VAR,
	STAGING_CODING_AGENTS_URL,
	STAGING_MCP_URL,
	URL_ENV_VAR,
	codingAgentsUrl,
	mcpUrl,
} = await import("../extensions/core/config.ts");

test("the baked-in constants sit on the api and app hosts, not the marketing apex", () => {
	assert.equal(DEFAULT_MCP_URL, "https://api.devspec.ai/api/mcp");
	assert.equal(STAGING_MCP_URL, "https://api.devspecstaging.com/api/mcp");
	assert.equal(CODING_AGENTS_URL, "https://app.devspec.ai/settings/coding-agents");
	assert.equal(STAGING_CODING_AGENTS_URL, "https://app.devspecstaging.com/settings/coding-agents");
	assert.equal(URL_ENV_VAR, "DEVSPEC_MCP_URL");
	assert.equal(ENV_ENV_VAR, "DEVSPEC_ENV");
});

test("mcpUrl defaults to the production API host with nothing set", () => {
	assert.equal(mcpUrl(), "https://api.devspec.ai/api/mcp");
	assert.equal(codingAgentsUrl(), "https://app.devspec.ai/settings/coding-agents");
});

test("DEVSPEC_ENV=staging selects the staging API host and its Coding agents page", () => {
	process.env.DEVSPEC_ENV = "staging";
	try {
		assert.equal(mcpUrl(), "https://api.devspecstaging.com/api/mcp");
		assert.equal(codingAgentsUrl(), "https://app.devspecstaging.com/settings/coding-agents");
	} finally {
		delete process.env.DEVSPEC_ENV;
	}
});

test("DEVSPEC_ENV is case-insensitive and any other value means production", () => {
	process.env.DEVSPEC_ENV = " Staging ";
	try {
		assert.equal(mcpUrl(), STAGING_MCP_URL);
		process.env.DEVSPEC_ENV = "production";
		assert.equal(mcpUrl(), DEFAULT_MCP_URL);
	} finally {
		delete process.env.DEVSPEC_ENV;
	}
});

test("DEVSPEC_MCP_URL is returned as set (trimmed) and beats DEVSPEC_ENV", () => {
	process.env.DEVSPEC_ENV = "staging";
	process.env.DEVSPEC_MCP_URL = "  http://localhost:3000/api/mcp  ";
	try {
		assert.equal(mcpUrl(), "http://localhost:3000/api/mcp");
	} finally {
		delete process.env.DEVSPEC_MCP_URL;
		delete process.env.DEVSPEC_ENV;
	}
});

test("a blank DEVSPEC_MCP_URL is ignored rather than returned as an empty endpoint", () => {
	process.env.DEVSPEC_MCP_URL = "   ";
	try {
		assert.equal(mcpUrl(), DEFAULT_MCP_URL);
	} finally {
		delete process.env.DEVSPEC_MCP_URL;
	}
});
