#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { npmInvocation } from "./npm-invocation.mjs";

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const [npmBuild, npmBuildArgs] = npmInvocation(["run", "build", "--silent"]);
await execFile(npmBuild, npmBuildArgs, { cwd: root });
assert.equal(packageJson.bin.bcu, "dist/bcu.mjs");
assert.deepEqual(packageJson.os, ["darwin"]);
assert.deepEqual(packageJson.cpu, ["arm64"]);
assert.equal(packageJson.author, "Zane Chee (upstream author)");
assert.match(packageJson.repository.url, /github\.com\/injaneity\/pi-computer-use/);

const [npm, npmArgs] = npmInvocation(["pack", "--dry-run", "--json", "--ignore-scripts"]);
const { stdout } = await execFile(npm, npmArgs, { cwd: root, maxBuffer: 4 * 1024 * 1024 });
const report = JSON.parse(stdout)[0];
assert(report && Array.isArray(report.files), "npm pack did not return a file manifest");
const files = new Set(report.files.map((entry) => entry.path));
for (const required of [
	"dist/bcu.mjs",
	"native/macos/bridge.swift",
	"prebuilt/macos/arm64/bridge",
	"scripts/setup-helper.mjs",
	"docs/usage.md",
	"README.md",
	"LICENSE",
]) assert(files.has(required), `npm tarball is missing ${required}`);
for (const file of files) {
	assert(!/^(?:node_modules|prebuilt\/macos\/x64|prebuilt\/windows|native\/windows|demo|notes|assets)(?:\/|$)/.test(file), `forbidden package file: ${file}`);
}
const bundle = await fs.readFile(path.join(root, "dist", "bcu.mjs"));
assert(bundle.toString().startsWith("#!/usr/bin/env node\n"), "dist/bcu.mjs is not an executable CLI entrypoint");
const helper = await fs.readFile(path.join(root, "prebuilt/macos/arm64/bridge"));
assert.equal(helper.subarray(0, 4).toString("hex"), "cffaedfe", "helper is not an arm64 Mach-O executable");

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bcu-package-"));
const helperApp = path.join(temporaryRoot, "bcu.app");
const env = { ...process.env, BCU_HELPER_APP_PATH: helperApp, BCU_NO_SIGN: "1" };
try {
	const setupScript = path.join(root, "scripts/setup-helper.mjs");
	await execFile(process.execPath, [setupScript, "--runtime"], { cwd: root, env });
	await execFile(process.execPath, [setupScript, "--runtime"], { cwd: root, env });
	const installed = path.join(helperApp, "Contents/MacOS/bridge");
	assert.equal((await fs.stat(installed)).mode & 0o111, 0o111, "helper was not installed executable");
	assert.equal((await fs.readFile(installed)).equals(helper), true, "installed helper differs from packaged helper");
} finally {
	await fs.rm(temporaryRoot, { recursive: true, force: true });
}

const clientRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bcu-install-check-"));
const clientApp = path.join(clientRoot, "bcu.app");
const clientExecutable = path.join(clientApp, "Contents/MacOS/bridge");
const previousEnvironment = {
	BCU_HELPER_APP_PATH: process.env.BCU_HELPER_APP_PATH,
	BCU_NO_SIGN: process.env.BCU_NO_SIGN,
};
try {
	await fs.mkdir(path.dirname(clientExecutable), { recursive: true });
	await fs.copyFile(path.join(root, "prebuilt/macos/arm64/bridge"), clientExecutable);
	await fs.chmod(clientExecutable, 0o755);
	const setupScript = path.join(root, "scripts/setup-helper.mjs");
	process.env.BCU_HELPER_APP_PATH = clientApp;
	process.env.BCU_NO_SIGN = "1";
	await execFile(process.execPath, [setupScript, "--runtime"], { cwd: root, env: process.env });
	const infoPath = path.join(clientApp, "Contents/Info.plist");
	const oldInfo = (await fs.readFile(infoPath, "utf8"))
		.replace(/(<key>CFBundleShortVersionString<\/key><string>)[^<]*(<\/string>)/, "$1old$2")
		.replace(/(<key>CFBundleVersion<\/key><string>)[^<]*(<\/string>)/, "$1old$2");
	await fs.writeFile(infoPath, oldInfo);
	delete process.env.BCU_NO_SIGN;
	const { MacosHelperClient } = await import("../src/platform/macos/helper.ts");
	const client = new MacosHelperClient();
	try {
		await client.ensureInstalled();
		assert.equal(await fs.readFile(infoPath, "utf8"), oldInfo, "runtime check replaced a helper with only an old version plist");
	} finally {
		client.dispose();
	}
	await fs.copyFile("/bin/echo", clientExecutable);
	process.env.BCU_NO_SIGN = "1";
	const repairClient = new MacosHelperClient();
	try {
		await repairClient.ensureInstalled();
		assert.equal((await fs.readFile(clientExecutable)).equals(helper), true, "runtime check did not repair a replaced helper binary");
	} finally {
		repairClient.dispose();
	}
} finally {
	for (const [key, value] of Object.entries(previousEnvironment)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await fs.rm(clientRoot, { recursive: true, force: true });
}
console.log(`Package manifest and idempotent arm64 helper checks passed (${report.entryCount} files).`);
