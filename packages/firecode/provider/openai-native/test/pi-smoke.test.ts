import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("pi-openai-native", () => {
	test("loads as a local extension and registers its flag without a provider request", () => {
		const extensionDir = path.resolve(import.meta.dir, "../../..");
		const isolated = mkdtempSync(path.join(tmpdir(), "firecode-smoke-"));
		cpSync(extensionDir, isolated, { recursive: true });
		const configPath = path.join(isolated, "config.jsonc");
		writeFileSync(configPath, readFileSync(configPath, "utf8").replace(/("openaiNative"\s*:\s*)false/, "$1true"));
		try {
			const result = spawnSync("pi", ["--no-extensions", "-e", isolated, "--help"], { encoding: "utf8" });
			expect(result.status).toBe(0);
			expect(result.stdout).toContain("--verbosity");
		} finally {
			rmSync(isolated, { recursive: true, force: true });
		}
	});
});
