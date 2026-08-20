import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

describe("pi-openai-native", () => {
	test("loads as a local extension and registers its flag without a provider request", () => {
		const extensionDir = path.resolve(import.meta.dir, "../../..");
		const result = spawnSync("pi", ["--no-extensions", "-e", extensionDir, "--help"], {
			encoding: "utf8",
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("--verbosity");
	});
});
