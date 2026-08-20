#!/usr/bin/env node
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { CLI_COMMANDS } from "../src/cli.ts";
import { loadComputerUseConfig } from "../src/config.ts";
import { CLI_COMMAND_NAMES } from "../src/contract.ts";
import { ensurePermissions } from "../src/permissions.ts";

assert.deepEqual(Object.keys(CLI_COMMANDS), [...CLI_COMMAND_NAMES], "CLI command table drifted from src/contract.ts");
for (const name of CLI_COMMAND_NAMES) assert.equal(typeof CLI_COMMANDS[name], "function", `${name} has no executor`);

assert.throws(
	() => ensurePermissions(
		{ accessibility: false, screenRecording: true },
		["accessibility", "screenRecording"],
		"Permissions are required.",
	),
	(error) => error?.code === "permission_missing" && error.message.includes("bcu setup"),
	"missing permissions must fail non-interactively with setup guidance",
);

const previousHeadless = process.env.BCU_HEADLESS;
try {
	process.env.BCU_HEADLESS = "1";
	const loaded = loadComputerUseConfig();
	assert.equal(loaded.sources.length, 1, "config must have one file source");
	assert.equal(loaded.sources[0].path, path.join(os.homedir(), ".config", "bcu", "config.json"));
	assert.equal(loaded.config.headless, true, "BCU_* environment variables must override the config file");
} finally {
	if (previousHeadless === undefined) delete process.env.BCU_HEADLESS;
	else process.env.BCU_HEADLESS = previousHeadless;
	loadComputerUseConfig();
}

console.log("Core contract checks passed.");
