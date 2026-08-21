#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMacosHelperAppPath } from "../src/platform/macos/helper-path.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperAppPath = resolveMacosHelperAppPath();
const helperExecutablePath = path.join(helperAppPath, "Contents", "MacOS", "bridge");
const helperSourceHashPath = path.join(helperAppPath, "Contents", "Resources", "source.sha256");
const helperInstalledHashPath = path.join(helperAppPath, "Contents", "Resources", "installed.sha256");
const helperBundleId = "dev.myagentworkstation.bcu";
const helperSources = ["agent_cursor.swift", "agent_cursor_motion.swift", "bridge.swift"].map((file) => path.join(rootDir, "native", "macos", file));
const prebuiltPath = path.join(rootDir, "prebuilt", "macos", "arm64", "bridge");
const allowBuild = process.argv.includes("--allow-build") || process.argv.includes("--runtime") || process.env.BCU_ALLOW_BUILD === "1";
const runtime = process.argv.includes("--runtime");
const postinstall = process.argv.includes("--postinstall");
const allowAdhocUpdate = process.argv.includes("--allow-adhoc-update") || process.env.BCU_ALLOW_ADHOC_UPDATE === "1";
const frameworks = ["ApplicationServices", "AppKit", "ScreenCaptureKit", "Foundation", "SwiftUI"];

async function exists(filePath) {
	try {
		await fs.access(filePath, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function run(command, args) {
	await new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: "inherit" });
		child.on("error", reject);
		child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Command failed (${code}): ${command} ${args.join(" ")}`)));
	});
}

async function packageVersion() {
	const packageJson = JSON.parse(await fs.readFile(path.join(rootDir, "package.json"), "utf8"));
	return packageJson.version;
}

async function hash(filePath) {
	return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function comparableInfo(info) {
	return info
		?.replace(/(<key>CFBundleShortVersionString<\/key><string>)[^<]*(<\/string>)/, "$1$2")
		.replace(/(<key>CFBundleVersion<\/key><string>)[^<]*(<\/string>)/, "$1$2");
}

async function registerHelperApp() {
	if (process.env.BCU_HELPER_APP_PATH) return;
	const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
	if (await exists(lsregister)) await run(lsregister, ["-f", helperAppPath]).catch(() => {});
}

async function signHelper() {
	if (process.env.BCU_NO_SIGN === "1") return;
	const identity = process.env.BCU_CODESIGN_IDENTITY ?? "-";
	await run("codesign", ["--force", "--deep", "-i", helperBundleId, "--timestamp=none", "--sign", identity, helperAppPath]);
	if (identity === "-") console.warn("[bcu] helper signed ad-hoc; macOS may require permission review after native changes.");
}

async function installHelper(sourcePath) {
	await fs.access(path.dirname(helperAppPath), fsConstants.W_OK);
	const version = await packageVersion();
	const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${helperBundleId}</string>
<key>CFBundleName</key><string>bcu</string>
<key>CFBundleDisplayName</key><string>bcu</string>
<key>CFBundleExecutable</key><string>bridge</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
</dict></plist>\n`;
	const sourceHash = await hash(sourcePath);
	const infoPath = path.join(helperAppPath, "Contents", "Info.plist");
	const existingSourceHash = (await fs.readFile(helperSourceHashPath, "utf8").catch(() => undefined))?.trim();
	const existingInstalledHash = (await fs.readFile(helperInstalledHashPath, "utf8").catch(() => undefined))?.trim();
	const existingInfo = await fs.readFile(infoPath, "utf8").catch(() => undefined);
	const installedHash = await hash(helperExecutablePath).catch(() => undefined);
	const infoMatches = comparableInfo(existingInfo) === comparableInfo(infoPlist);
	// Signing rewrites the Mach-O, so the installed binary never hashes to the source
	// hash; installed.sha256 records the final post-sign bytes for tamper detection.
	const installedIntact = installedHash !== undefined && installedHash === existingInstalledHash;
	if (existingSourceHash === sourceHash && installedIntact && infoMatches) {
		await registerHelperApp();
		return false;
	}
	if (runtime && installedIntact) {
		console.warn("[bcu] installed helper is intact but has older metadata or code; continuing without replacement to preserve macOS permissions.");
		return false;
	}
	if (installedIntact && process.env.BCU_NO_SIGN !== "1" && !allowAdhocUpdate && !process.env.BCU_CODESIGN_IDENTITY) {
		throw new Error("Refusing to replace an installed ad-hoc helper because macOS may reset permissions. Use a signed identity or set BCU_ALLOW_ADHOC_UPDATE=1 for local development.");
	}
	await fs.mkdir(path.dirname(helperExecutablePath), { recursive: true });
	await fs.mkdir(path.dirname(helperSourceHashPath), { recursive: true });
	await fs.copyFile(sourcePath, helperExecutablePath);
	await fs.chmod(helperExecutablePath, 0o755);
	await fs.writeFile(infoPath, infoPlist);
	await fs.writeFile(helperSourceHashPath, `${sourceHash}\n`);
	await signHelper();
	await fs.writeFile(helperInstalledHashPath, `${await hash(helperExecutablePath)}\n`);
	await registerHelperApp();
	return true;
}

async function buildHelper(outputPath) {
	for (const source of helperSources) await fs.access(source);
	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	const args = ["swiftc", "-target", "arm64-apple-macosx14.0", "-module-cache-path", path.join(os.tmpdir(), "bcu-swift-module-cache-arm64"), "-O"];
	for (const framework of frameworks) args.push("-framework", framework);
	args.push(...helperSources, "-o", outputPath);
	await run("xcrun", args);
	await fs.chmod(outputPath, 0o755);
}

async function setup() {
	if (process.platform !== "darwin" || process.arch !== "arm64") {
		if (postinstall) {
			console.warn("[bcu] skipping helper setup: Apple Silicon macOS is required.");
			return;
		}
		throw new Error("bcu helper requires Apple Silicon macOS.");
	}
	if (await exists(prebuiltPath)) {
		const installed = await installHelper(prebuiltPath);
		console.log(installed ? `[bcu] installed helper app at ${helperAppPath}` : `[bcu] helper app already current at ${helperAppPath}`);
		return;
	}
	if (!allowBuild) throw new Error(`No macOS arm64 helper found at ${prebuiltPath}. Run 'npm run build:native' to build locally.`);
	const temporaryPath = path.join(os.tmpdir(), `bcu-bridge-${process.pid}-${Date.now()}`);
	try {
		console.log("[bcu] prebuilt helper missing; building with xcrun swiftc...");
		await buildHelper(temporaryPath);
		const installed = await installHelper(temporaryPath);
		console.log(installed ? `[bcu] built helper app at ${helperAppPath}` : `[bcu] helper app already current at ${helperAppPath}`);
	} finally {
		await fs.rm(temporaryPath, { force: true }).catch(() => {});
	}
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) setup().catch((error) => {
	if (postinstall) {
		console.warn(`[bcu] postinstall helper setup skipped: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(0);
	}
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
