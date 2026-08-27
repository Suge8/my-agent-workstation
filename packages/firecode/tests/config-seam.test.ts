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
			"master/prompts/master.zh.md",
			"master/prompts/worker.zh.md",
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

test("Master 固定角色对象严格解析原子与 fallback", async () => {
	const { parseMasterConfig } = await loadFirecodeModule("config.ts") as any;
	const validProblems: string[] = [];
	const parsed = parseMasterConfig({
		roles: {
			工程师: { model: "test/shared/medium", use: "实现", fallback: ["test/backup/high"] },
			哨兵: { model: "test/shared/low", use: "盯守" },
		},
	}, validProblems);
	expect(validProblems).toEqual([]);
	expect(parsed.roles).toEqual([
		{
			role: "工程师", model: "test/shared", thinking: "medium", use: "实现",
			fallback: [{ model: "test/backup", thinking: "high" }],
		},
		{ role: "哨兵", model: "test/shared", thinking: "low", use: "盯守", fallback: [] },
	]);

	const problems: string[] = [];
	parseMasterConfig({
		roles: {
			工程师: {
				model: "invalid-model/high", thinking: "medium", use: "旧写法",
				fallback: ["test/a/low", "test/b/low", "test/c/low"],
			},
			哨兵: { model: "test/model/turbo", use: "坏档" },
			调研员: { model: "test/model", use: "漏写思考档" },
			自定义角色: { model: "test/model/low", use: "未知" },
		},
	}, problems);
	expect(problems).toContain("未知角色 master.roles.自定义角色，可用：调研员 / 工程师 / 全栈 / 架构师 / 设计师 / 哨兵");
	expect(problems).toContain("未知字段 master.roles.工程师.thinking");
	expect(problems).toContain(
		"master.roles.工程师.model 必须是“provider/model/thinking”字符串（模型段不是 provider/model：invalid-model）",
	);
	expect(problems).toContain("master.roles.哨兵.model 必须是“provider/model/thinking”字符串（思考档无效：turbo）");
	// 两段式旧写法同时踩中两项校验，仍然只报一条并给出目标形状。
	expect(problems).toContain(
		"master.roles.调研员.model 必须是“provider/model/thinking”字符串（模型段不是 provider/model：test；思考档无效：model）",
	);
	expect(problems).toContain("master.roles.工程师.fallback 必须是至多 2 项的数组");

	const emptyProblems: string[] = [];
	parseMasterConfig({ roles: {} }, emptyProblems);
	expect(emptyProblems).toContain("master.roles 必须是至少包含一个固定角色的对象");

	const legacyProblems: string[] = [];
	parseMasterConfig({ models: [{ role: "工程师", model: "test/model/low", use: "旧数组" }] }, legacyProblems);
	expect(legacyProblems).toEqual(["未知字段 master.models"]);
});

test("preset 只认模型原子，旧的三字段写法被拒", async () => {
	const { loadConfig } = await loadFirecodeModule("config.ts", {
		configJsonc: JSON.stringify({
			presets: {
				new: { model: "test/model/high", key: "alt+1" },
				old: { provider: "test", model: "model", thinkingLevel: "high" },
			},
		}),
	});
	const loaded = (loadConfig as () => { config: any; problems: string[] })();

	expect(loaded.config.presets.new.model).toEqual({ model: "test/model", thinking: "high" });
	expect(loaded.problems).toContain("未知字段 presets.old.provider");
	expect(loaded.problems).toContain("未知字段 presets.old.thinkingLevel");
	expect(loaded.problems).toContain(
		"presets.old.model 必须是“provider/model/thinking”字符串（模型段不是 provider/model：model；思考档无效：model）",
	);
});

test("公共配置模板可解析并启用完整推荐工作流", async () => {
	const configJsonc = await readFile(join(FIRECODE_DIR, "config.example.jsonc"), "utf8");
	const { loadConfig } = await loadFirecodeModule("config.ts", { configJsonc });
	const loaded = (loadConfig as () => { config: any; problems: string[] })();

	expect(loaded.problems).toEqual([]);
	for (const feature of ["claudeSub", "openaiNative", "review", "master", "watcher"])
		expect(loaded.config.features[feature]).toBeTrue();
	expect(loaded.config.features.bark).toBeFalse();
	expect(loaded.config.master.autoActivate).toBeTrue();
	expect(loaded.config.master.roles.map((entry: any) => entry.role)).toEqual([
		"调研员", "工程师", "全栈", "架构师", "设计师", "哨兵",
	]);
	expect(loaded.config.watcher.enabled).toBeTrue();
	expect(configJsonc).toContain("每个主会话回合后调用模型");
});
