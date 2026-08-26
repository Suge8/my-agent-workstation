import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { cleanupFirecodeModules, copyFirecodeSource, FIRECODE_DIR, loadFirecodeModule } from "./loader.ts";

afterEach(cleanupFirecodeModules);

test("portable loader copies runtime sources without repository metadata or development docs", async () => {
	const directory = await mkdtemp(join(tmpdir(), "firecode-copy-"));
	try {
		await copyFirecodeSource(directory);
		expect(existsSync(join(directory, "index.ts"))).toBeTrue();
		expect(existsSync(join(directory, ".git"))).toBeFalse();
		expect(existsSync(join(directory, "docs"))).toBeFalse();
		expect(existsSync(join(directory, "tests"))).toBeFalse();
		expect(
			(await readdir(directory, { recursive: true }))
				.filter((path) => /\.mdx?$/.test(path))
				.map((path) => path.split(sep).join("/"))
				.sort(),
		).toEqual([
			"review/prompts/advisor.en.md",
			"review/prompts/advisor.zh.md",
			"review/prompts/review.en.md",
			"review/prompts/review.zh.md",
			"watcher/prompts/watch.zh.md",
		]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

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
		"FireCode 配置有问题：config.jsonc 不存在，已关闭可选功能",
		"FireCode 配置有问题：config.jsonc 不存在，已关闭可选功能",
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
			"watcher",
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

test("公共配置模板可解析且认证相关功能安全关闭", async () => {
	const configJsonc = await readFile(join(FIRECODE_DIR, "config.example.jsonc"), "utf8");
	const { loadConfig } = await loadFirecodeModule("config.ts", { configJsonc });
	const loaded = (loadConfig as () => { config: any; problems: string[] })();

	expect(loaded.problems).toEqual([]);
	for (const feature of ["review", "master", "watcher", "bark"])
		expect(loaded.config.features[feature]).toBeFalse();
	expect(configJsonc).toContain("换成你有认证的模型");
	expect(configJsonc).toContain("功能开关");
});
