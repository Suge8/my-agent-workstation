import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { parseJsonc } from "../jsonc.ts";
import { FIRECODE_DIR, cleanupFirecodeModules, loadFirecodeModule } from "./loader.ts";

afterEach(cleanupFirecodeModules);

test("binds exactly the shortcuts declared by preset key fields", async () => {
	const { presets } = parseJsonc(readFileSync(join(FIRECODE_DIR, "config.example.jsonc"), "utf8")) as {
		presets: Record<string, { key?: string }>;
	};
	const declared = Object.values(presets as Record<string, { key?: string }>)
		.map((preset) => preset.key)
		.filter((key): key is string => !!key);
	expect(declared.length).toBeGreaterThan(0);

	const shortcuts: string[] = [];
	const { registerPresets } = await loadFirecodeModule("session/presets.ts");
	(registerPresets as (pi: unknown) => void)({
		registerFlag() {},
		registerShortcut(key: string) {
			shortcuts.push(key);
		},
		registerCommand() {},
		on() {},
	} as never);

	for (const key of declared) expect(shortcuts).toContain(key);
	expect(shortcuts).toContain("ctrl+shift+u");
	// 没写 key 的预设不占用按键。
	expect(shortcuts).toHaveLength(declared.length + 1);
});
