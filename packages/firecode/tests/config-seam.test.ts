import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { cleanupFirecodeModules, FIRECODE_DIR, loadFirecodeModule } from "./loader.ts";

afterEach(cleanupFirecodeModules);

test("missing runtime config disables optional behavior and warns on each session_start", async () => {
	const { default: registerFirecode } = await loadFirecodeModule("index.ts", { configJsonc: null });
	const commands: string[] = [];
	const shortcuts: string[] = [];
	const tools: string[] = [];
	const renderers: string[] = [];
	const events = new Map<string, Array<(...args: unknown[]) => void>>();
	const pi = {
		registerCommand: (name: string) => commands.push(name),
		registerShortcut: (key: string) => shortcuts.push(key),
		registerTool: ({ name }: { name: string }) => tools.push(name),
		registerMessageRenderer: (name: string) => renderers.push(name),
		on: (name: string, handler: (...args: unknown[]) => void) =>
			events.set(name, [...(events.get(name) ?? []), handler]),
	};

	(registerFirecode as (pi: unknown) => void)(pi);

	expect(commands).toEqual([]);
	expect(shortcuts).toEqual([]);
	expect(tools).toEqual([]);
	expect(renderers).toEqual(["firecode-review-card"]);
	const warnings: string[] = [];
	for (let occurrence = 0; occurrence < 2; occurrence++)
		for (const handler of events.get("session_start") ?? [])
			handler({}, { ui: { notify: (message: string) => warnings.push(message) } });
	expect(warnings).toEqual([
		"FireCode 配置：config.jsonc 不存在，已关闭可选功能",
		"FireCode 配置：config.jsonc 不存在，已关闭可选功能",
	]);
});

test("runtime config enables only its declared behavior", async () => {
	const configJsonc = JSON.stringify({
		features: Object.fromEntries([
			"header",
			"statusbar",
			"tools",
			"presets",
			"stats",
			"claudeSub",
			"openaiNative",
			"workingFlame",
			"bark",
			"review",
			"master",
		].map((feature) => [feature, false]).concat([["rename", true]])),
		keys: { rename: "alt+r" },
	});
	const { default: registerFirecode } = await loadFirecodeModule("index.ts", { configJsonc });
	const commands: string[] = [];
	const shortcuts: string[] = [];
	(registerFirecode as (pi: unknown) => void)({
		registerCommand: (name: string) => commands.push(name),
		registerShortcut: (key: string) => shortcuts.push(key),
		registerMessageRenderer() {},
		on() {},
	});

	expect(commands).toEqual(["rename"]);
	expect(shortcuts).toEqual(["alt+r"]);
});

test("public config template is accepted by the runtime parser", async () => {
	const configJsonc = await readFile(join(FIRECODE_DIR, "config.example.jsonc"), "utf8");
	const { loadConfig } = await loadFirecodeModule("config.ts", { configJsonc });

	expect((loadConfig as () => { problems: string[] })().problems).toEqual([]);
});
