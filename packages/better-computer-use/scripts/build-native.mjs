#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePaths = ["agent_cursor.swift", "agent_cursor_motion.swift", "bridge.swift"]
	.map((file) => path.join(rootDir, "native", "macos", file));
const outputDefault = path.join(rootDir, "prebuilt", "macos", "arm64", "bridge");
const frameworks = ["ApplicationServices", "AppKit", "ScreenCaptureKit", "Foundation", "SwiftUI"];
const target = "arm64-apple-macosx14.0";

function arg(name) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasArg(name) {
	return process.argv.includes(name);
}

async function run(command, args) {
	await new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: "inherit" });
		child.on("error", reject);
		child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Command failed (${code}): ${command} ${args.join(" ")}`)));
	});
}

function moduleCachePath() {
	return path.join(os.tmpdir(), "bcu-swift-module-cache-arm64");
}

async function build(outputPath) {
	for (const sourcePath of sourcePaths) await fs.access(sourcePath);
	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	const args = ["swiftc", "-target", target, "-module-cache-path", moduleCachePath(), "-O"];
	for (const framework of frameworks) args.push("-framework", framework);
	args.push(...sourcePaths, "-o", outputPath);
	console.log("Building macOS arm64 helper...");
	await run("xcrun", args);
	await fs.chmod(outputPath, 0o755);
	if (!hasArg("--no-sign") && process.env.BCU_NO_SIGN !== "1") {
		const identity = arg("--sign-identity") ?? process.env.BCU_CODESIGN_IDENTITY ?? "-";
		const identifier = arg("--sign-identifier") ?? "dev.myagentworkstation.bcu";
		await run("codesign", ["--force", "-i", identifier, "--timestamp=none", "--sign", identity, outputPath]);
	}
	console.log(`Built helper at ${outputPath}`);
}

async function main() {
	if (process.platform !== "darwin" || process.arch !== "arm64") {
		throw new Error("better-computer-use requires Apple Silicon macOS.");
	}
	const output = arg("--output");
	await build(output ? path.resolve(process.cwd(), output) : outputDefault);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
