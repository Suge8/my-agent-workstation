#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { validateActions } from "../src/actions.ts";
import { ERROR_CODE_ALIASES, normalizeCliError, toolResultFailure } from "../src/errors.ts";
import { npmInvocation } from "./npm-invocation.mjs";

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(root, "dist", "bcu.mjs");
const [npm, npmArgs] = npmInvocation(["run", "build", "--silent"]);
await execFile(npm, npmArgs, { cwd: root });
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bcu-cli-errors-"));
const socketPath = path.join(temporaryRoot, "broker.sock");

function coded(code, message = "opaque native failure") {
	return Object.assign(new Error(message), { code });
}

function sourceErrorCodes() {
	const swift = readFileSync(path.join(root, "native", "macos", "bridge.swift"), "utf8");
	return new Set([...swift.matchAll(/code:\s*"([a-z0-9_]+)"/g)].map((match) => match[1]));
}

function checkKnownErrorsAndFailures() {
	for (const code of sourceErrorCodes()) {
		assert(code in ERROR_CODE_ALIASES, `native error '${code}' has no explicit public mapping`);
		const normalized = normalizeCliError(coded(code));
		assert.equal(normalized.code, ERROR_CODE_ALIASES[code], `native error '${code}' used message inference`);
	}
	assert.equal(toolResultFailure({ text: "timed out", details: { tool: "wait_for", found: false } })?.code, "action_timeout");
	assert.equal(toolResultFailure({ text: "failed", details: { tool: "act_ui", execution: { outcome: "didnt" } } })?.code, "action_failed");
	assert.equal(toolResultFailure({ text: "uncertain", details: { tool: "act_ui", execution: { outcome: "unknown" } } })?.code, "action_failed");
}

function checkActionValidation() {
	const invalidActions = [
		["numeric ref", { action: "click", ref: 123 }],
		["empty ref", { action: "click", ref: "" }],
		["invalid button", { action: "click", ref: "@e1", button: "banana" }],
		["invalid clickCount type", { action: "click", ref: "@e1", clickCount: "many" }],
		["invalid clickCount range", { action: "click", ref: "@e1", clickCount: 4 }],
		["ignored doubleClick count", { action: "doubleClick", ref: "@e1", clickCount: 2 }],
		["invalid scrollY", { action: "scroll", ref: "@e1", scrollY: "abc" }],
		["invalid scroll range", { action: "scroll", ref: "@e1", scrollX: 10_001 }],
		["invalid wait ms", { action: "wait", ms: "soon" }],
		["invalid wait range", { action: "wait", ms: 60_001 }],
		["partial coordinates", { action: "click", x: 10 }],
		["mixed targets", { action: "click", ref: "@e1", x: 10, y: 10 }],
		["missing keys", { action: "keypress" }],
		["invalid keys", { action: "keypress", ref: "@e1", keys: [1] }],
		["orphaned typing", { action: "typeText", text: "orphaned" }],
		["missing text", { action: "setText", ref: "@e1" }],
		["short drag", { action: "drag", path: [{ x: 1, y: 1 }] }],
		["invalid drag point", { action: "drag", path: [{ x: 1, y: 1 }, { x: "bad", y: 2 }] }],
		["unsupported field", { action: "wait", button: "left" }],
		["unknown field", { action: "click", ref: "@e1", extra: true }],
		["missing target", { action: "click" }],
	];
	for (const [label, action] of invalidActions) {
		assert.throws(
			() => validateActions([action]),
			(error) => normalizeCliError(error).code === "invalid_arguments",
			`${label} did not map to invalid_arguments`,
		);
	}
	for (const actions of [
		[{ action: "click", ref: "@e1" }],
		[{ action: "click", x: 10, y: 10, button: "middle", clickCount: 3 }],
		[{ action: "scroll", ref: "@e1" }],
		[{ action: "wait" }],
		[{ action: "wait", ms: 0 }],
		[{ action: "drag", path: [[1, 1], { x: 2, y: 2 }] }],
		[{ action: "setText", ref: "@e1", text: "" }],
		[{ action: "click", x: 10, y: 10 }, { action: "typeText", text: "focused" }],
	]) assert.doesNotThrow(() => validateActions(actions));
	assert.throws(() => validateActions([]), (error) => normalizeCliError(error).code === "invalid_arguments");
	assert.throws(() => validateActions(Array.from({ length: 21 }, () => ({ action: "wait" }))), (error) => normalizeCliError(error).code === "invalid_arguments");
	const actionSource = readFileSync(path.join(root, "src", "actions.ts"), "utf8");
	assert(!actionSource.includes("toFiniteNumber"), "action boundary still silently coerces invalid values");
}

function run(args, { env = {}, input = "" } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [bundle, ...args], {
			cwd: root,
			env: { ...process.env, BCU_BROKER_SOCKET_PATH: socketPath, ...env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", reject);
		child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
		child.stdin.end(input);
	});
}

function assertFailure(result, code) {
	assert.notEqual(result.code, 0, `${code} unexpectedly exited zero`);
	assert.equal(result.stdout, "", `${code} wrote protocol errors to stdout`);
	const lines = result.stderr.trim().split("\n");
	assert.match(lines[0] ?? "", new RegExp(`^error ${code}: .+`), `${code} has an unstable error line`);
	assert.match(lines[1] ?? "", /^recovery: .+/, `${code} omitted recovery guidance`);
}

function fakeBroker() {
	const server = net.createServer((socket) => {
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk;
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				const request = JSON.parse(line);
				if (request.cmd === "hello") {
					socket.write(`${JSON.stringify({ id: request.id, ok: true, result: { brokerVersion: 1, helperProtocolVersion: null, pid: process.pid } })}\n`);
					continue;
				}
				if (request.cmd === "observe-ui" && request.args.app === "__bcu_compact_output__") {
					const result = {
						text: "Outline (1 node, stateId state-1):\n@e1 AXWindow",
						details: {
							tool: "observe_ui",
							capture: { stateId: "state-1" },
							execution: { strategy: "look" },
							outline: { lookId: 1, root: { ref: "@e1", role: "AXWindow", children: [] } },
							renderedOutline: "@e1 AXWindow",
							lookId: 1,
							note: { windowRef: "@r1" },
							config: { headless: false },
							helper: { protocolVersion: 6 },
						},
					};
					socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
					continue;
				}
				const errors = {
					"act-ui": { code: "stale_state", message: `State '${request.args.stateId}' is unavailable or was evicted.` },
					"observe-ui": { code: "app_not_found", message: `App '${request.args.app}' is not running.` },
					"inspect-ui": { code: "element_not_found", message: `Outline ref '${request.args.ref}' is not available.` },
				};
				const error = errors[request.cmd] ?? { code: "internal_error", message: "Unexpected fake command." };
				socket.write(`${JSON.stringify({ id: request.id, ok: false, error })}\n`);
			}
		});
	});
	return server;
}

checkKnownErrorsAndFailures();
checkActionValidation();

const server = fakeBroker();
try {
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});

	const help = await run(["--help"]);
	assert.equal(help.code, 0, "bcu --help failed");
	const publicCommands = [
		"find-roots", "observe-ui", "search-ui", "expand-ui", "inspect-ui", "act-ui", "read-text", "wait-for",
		"browser launch", "browser navigate", "browser eval", "status", "doctor", "setup", "stop",
	];
	for (const command of publicCommands) {
		assert(help.stdout.includes(command), `bcu --help omitted ${command}`);
	}

	const compactOutput = await run(["observe-ui", "--app", "__bcu_compact_output__", "--json"]);
	assert.equal(compactOutput.code, 0, "compact JSON output failed");
	const compactDetails = JSON.parse(compactOutput.stdout).result.details;
	assert.deepEqual(compactDetails, {
		tool: "observe_ui",
		capture: { stateId: "state-1" },
		execution: { strategy: "look" },
	}, "public CLI leaked cached or diagnostic internals");

	assertFailure(await run(["expand-ui", "--state", "state-1"]), "invalid_arguments");
	assertFailure(await run(["act-ui", "--state", "state-1", "-"], { input: "not-json\n" }), "invalid_arguments");
	assertFailure(await run(["act-ui", "--state", "NONEXIST", "-"], { input: "[]\n" }), "stale_state");
	assertFailure(await run(["observe-ui", "--app", "__bcu_missing_app__"]), "app_not_found");
	assertFailure(await run(["inspect-ui", "--state", "state-1", "--ref", "@e404"]), "element_not_found");

	await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	await fs.rm(socketPath, { force: true });
	assertFailure(await run(["find-roots"], {
		env: { BCU_BROKER_ENTRY_PATH: path.join(temporaryRoot, "missing-broker.mjs") },
	}), "broker_unavailable");
	console.log(`CLI error checks passed (6 CLI scenarios, ${sourceErrorCodes().size} native codes, result failures, action validation).`);
} finally {
	if (server.listening) await new Promise((resolve) => server.close(resolve));
	await fs.rm(temporaryRoot, { recursive: true, force: true });
}
