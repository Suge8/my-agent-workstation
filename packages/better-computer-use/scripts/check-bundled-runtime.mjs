#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { setupHelperScriptPath } from "../src/package-root.ts";

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bcu-bundled-runtime-"));
const entry = 'import { setupHelperScriptPath } from "./src/package-root.ts";\nconsole.log(setupHelperScriptPath());\n';

async function checkLayout(packageRoot, label) {
	const setupScript = path.join(packageRoot, "scripts", "setup-helper.mjs");
	const bundle = path.join(packageRoot, "dist", "probe.mjs");
	await fs.mkdir(path.dirname(setupScript), { recursive: true });
	await fs.writeFile(setupScript, "// fixture\n");
	await build({ stdin: { contents: entry, resolveDir: root, sourcefile: "probe.ts" }, outfile: bundle, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
	const { stdout } = await execFile(process.execPath, [bundle]);
	assert.equal(await fs.realpath(stdout.trim()), await fs.realpath(setupScript), `${label} bundle resolved the wrong setup-helper path`);
}

try {
	assert.equal(await fs.realpath(setupHelperScriptPath()), await fs.realpath(path.join(root, "scripts", "setup-helper.mjs")), "source layout resolved the wrong setup-helper path");
	await checkLayout(path.join(temporaryRoot, "checkout"), "dist");
	await checkLayout(path.join(temporaryRoot, "consumer", "node_modules", "better-computer-use"), "packed");
	for (const relativePath of ["src/platform/macos/helper.ts"]) {
		const source = await fs.readFile(path.join(root, relativePath), "utf8");
		assert(source.includes("setupHelperScriptPath"), `${relativePath} does not use the shared package-root resolver`);
	}
	console.log("Bundled runtime path checks passed.");
} finally {
	await fs.rm(temporaryRoot, { recursive: true, force: true });
}
