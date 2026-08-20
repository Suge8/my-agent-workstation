import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { PI_TUI_URL, cleanupFirecodeModules, loadFirecodeModule } from "./loader.ts";

const temporaryDirectories: string[] = [];

type RenderContext = {
	state: Record<string, unknown>;
	cwd: string;
	toolCallId: string;
	isPartial: boolean;
	isError: boolean;
	expanded: boolean;
};
type RegisteredTool = {
	name: string;
	execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>;
	renderCall: (args: Record<string, unknown>, theme: Theme, context: RenderContext) => { render(width: number): string[] };
	renderResult: (
		result: { content: Array<{ type: string; text?: string }>; details?: unknown },
		options: { expanded: boolean; isPartial?: boolean },
		theme: Theme,
		context: RenderContext,
	) => { render(width: number): string[] };
};
type Theme = { fg(color: string, text: string): string; bold(text: string): string };
type SessionContext = { ui: WidgetUi };
type WidgetUi = {
	setWidget(key: string, factory?: (tui: FakeTui) => unknown): void;
	notify(message: string): void;
};
type FakeTui = { children: unknown[]; requestRender(): void };

// 只包装默认激活的 4 工具：原版 pi 注册即激活，包装 grep/find/ls 会把它们强制打开。
const toolNames = ["read", "bash", "edit", "write"] as const;
const theme: Theme = { fg: (_color, text) => text, bold: (text) => text };
afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
	await cleanupFirecodeModules();
});

async function loadExtension() {
	const [module, tuiModule] = await Promise.all([
		loadFirecodeModule("tools/index.ts"),
		import(PI_TUI_URL),
	]);
	return {
		extension: module.registerToolRendering as (pi: unknown) => void,
		visibleWidth: tuiModule.visibleWidth as (text: string) => number,
	};
}

function renderContext(overrides: Partial<RenderContext> = {}): RenderContext {
	return {
		state: {},
		cwd: "/tmp/project",
		toolCallId: crypto.randomUUID(),
		isPartial: false,
		isError: false,
		expanded: false,
		...overrides,
	};
}

test("renders compact status rows and joins only adjacent tool rows", async () => {
	const { extension, visibleWidth } = await loadExtension();
	const tools: Record<string, RegisteredTool> = {};
	let sessionStart: ((event: unknown, context: SessionContext) => Promise<void>) | undefined;
	let sessionShutdown: (() => Promise<void>) | undefined;
	extension({
		on(name: string, handler: typeof sessionStart | typeof sessionShutdown) {
			if (name === "session_start") sessionStart = handler as typeof sessionStart;
			if (name === "session_shutdown") sessionShutdown = handler as typeof sessionShutdown;
		},
		registerTool(tool: RegisteredTool) {
			tools[tool.name] = tool;
		},
		registerCommand() {},
		getActiveTools: () => [],
		getAllTools: () => [],
	} as never);
	if (!sessionStart || !sessionShutdown) throw new Error("session lifecycle handlers not registered");

	class ToolRow {
		toolCallId = "call-1";
		args: Record<string, unknown> = {};
		expanded = false;
		renderShell?: string;
		setExpanded(val: boolean) {
			this.expanded = val;
		}
		getRenderShell() {
			return this.renderShell;
		}
		constructor(readonly toolName: string, private readonly text: string, renderShell = "self") {
			this.renderShell = renderShell;
		}
		render(width = 76) {
			return ["", this.text];
		}
	}
	const first = new ToolRow("read", "first");
	const second = new ToolRow("bash", "second");
	const afterText = new ToolRow("edit", "after-text");
	const children: unknown[] = [first, second, { render() {} }, afterText];
	let findCalls = 0;
	const find = children.find.bind(children);
	children.find = ((predicate: (value: unknown) => boolean) => {
		findCalls++;
		return find(predicate);
	}) as typeof children.find;
	const chat = { children };
	const originalRequestRender = () => {};
	const tui: FakeTui = { children: [{ children: [chat] }], requestRender: originalRequestRender };
	const ui: WidgetUi = {
		setWidget(_key, factory) {
			if (factory) factory(tui);
		},
		notify(message) {
			throw new Error(message);
		},
	};
	await sessionStart({}, { ui });
	tui.requestRender();
	tui.requestRender();
	expect(findCalls).toBe(1);
	expect(first.render()).toEqual(["", "first"]);
	expect(second.render()).toEqual(["second"]);
	expect(afterText.render()).toEqual(["", "after-text"]);
	const appended = new ToolRow("write", "appended");
	children.push(appended);
	expect(appended.render()).toEqual(["appended"]);
	const grepAfterWrite = new ToolRow("grep", "grep-after-write");
	const readAfterGrep = new ToolRow("read", "read-after-grep");
	children.push(grepAfterWrite, readAfterGrep);
	expect(grepAfterWrite.render()).toEqual(["grep-after-write"]);
	expect(readAfterGrep.render()).toEqual(["read-after-grep"]);

	// Third-party tool (declaring self or default):
	// Collapsed: unified into compact single-line ToolLine fallback
	// Expanded: preserves original rendering
	const thirdParty = new ToolRow("subagent", "wide-custom-output", "default");
	thirdParty.args = { task: "run scout" };
	children.push(thirdParty);
	const renderedTpCollapsed = thirdParty.render(76);
	expect(renderedTpCollapsed.length).toBe(1);
	expect(stripVTControlCharacters(renderedTpCollapsed[0])).toContain("▏ ✓ subagent task: run scout");
	expect(visibleWidth(renderedTpCollapsed[0])).toBe(76);

	thirdParty.setExpanded(true);
	const renderedTpExpanded = thirdParty.render(76);
	expect(renderedTpExpanded).toEqual(["wide-custom-output"]);

	// Third-party tool declaring self: also unified into compact single-line when collapsed
	const thirdPartySelf = new ToolRow("custom_tool", "self-wide-output", "self");
	thirdPartySelf.args = { query: "analyze code" };
	children.push(thirdPartySelf);
	const renderedSelfCollapsed = thirdPartySelf.render(76);
	expect(renderedSelfCollapsed.length).toBe(1);
	expect(stripVTControlCharacters(renderedSelfCollapsed[0])).toContain("▏ ✓ custom_tool query: analyze code");
	expect(visibleWidth(renderedSelfCollapsed[0])).toBe(76);

	thirdPartySelf.setExpanded(true);
	const renderedSelfExpanded = thirdPartySelf.render(76);
	expect(renderedSelfExpanded).toEqual(["self-wide-output"]);

	await sessionShutdown();
	expect(second.render()).toEqual(["", "second"]);
	expect(tui.requestRender).toBe(originalRequestRender);
	await sessionStart({}, { ui });
	tui.requestRender();
	expect(second.render()).toEqual(["second"]);

	const readContext = renderContext();
	const blocks = [{ type: "text", text: "a".repeat(60) }, { type: "text", text: "b".repeat(60) }];
	tools.read.renderResult({ content: blocks }, { expanded: false }, theme, readContext);
	const readLine = tools.read.renderCall(
		{ path: "/tmp/project/src/parser.ts", offset: 1, limit: 200 }, theme, readContext,
	).render(76)[0];
	expect(readLine).toContain("▏ ✓ 读取 ./src/parser.ts:1-200");
	expect(readLine).toContain("0.1k");
	expect(visibleWidth(readLine)).toBe(76);
	expect(tools.read.renderCall(
		{ path: "/tmp/project/src/parser.ts", offset: 10 }, theme, renderContext(),
	).render(76)[0]).toContain("./src/parser.ts:10+");

	const expanded = tools.read.renderResult({ content: blocks }, { expanded: true }, theme, readContext).render(76).join("\n");
	expect(expanded).toContain("a".repeat(60));
	expect(expanded).toContain("b".repeat(60));
	const unsafeBlocks = [
		{ type: "text", text: "  alpha  \n" },
		{ type: "text", text: "\u001b[31mbeta\u001b[0m\u0000 " },
	];
	const unsafeExpanded = tools.read.renderResult(
		{ content: unsafeBlocks }, { expanded: true }, theme, renderContext(),
	).render(76);
	expect(unsafeExpanded).toEqual(["", "  alpha  ", "", "beta "]);
	expect(unsafeExpanded.join("\n")).not.toMatch(/[\u001b\u0000]/);
	const whitespaceExpanded = tools.read.renderResult(
		{ content: [{ type: "text", text: " \n " }] }, { expanded: true }, theme, renderContext(),
	).render(76);
	expect(whitespaceExpanded).toEqual(["", " ", " "]);
	const runningLine = tools.read.renderCall({ path: "a" }, theme, renderContext({ isPartial: true })).render(76)[0];
	expect(runningLine).toContain("▏ ● 读取");
	const errorContext = renderContext({ isError: true });
	tools.bash.renderResult(
		{ content: [{ type: "text", text: "Cannot find module" }] }, { expanded: false }, theme, errorContext,
	);
	expect(tools.bash.renderCall({ command: "npm run build" }, theme, errorContext).render(76)[0])
		.toContain("▏ ✗ 操作 $ npm run build · Cannot find module");
	const editContext = renderContext();
	tools.edit.renderResult(
		{ content: [{ type: "text", text: "ok" }], details: { diff: "+1 a\n+2 b\n-1 x" } },
		{ expanded: false }, theme, editContext,
	);
	expect(tools.edit.renderCall({ path: "/tmp/project/src/theme.ts" }, theme, editContext).render(76)[0])
		.toContain("▏ ✓ 修改 ./src/theme.ts +2 -1");
	const writeCases = [
		["", 0],
		["a\nb", 2],
		["a\nb\n", 2],
		["a\nb\n\n", 3],
	] as const;
	for (const [content, lines] of writeCases) {
		expect(tools.write.renderCall(
			{ path: "/tmp/project/docs/plan.md", content }, theme, renderContext(),
		).render(76)[0]).toContain(`▏ ✓ 写入 ./docs/plan.md +${lines}`);
	}

	const narrowContext = renderContext();
	tools.read.renderResult({ content: [{ type: "text", text: "x".repeat(52_000) }] }, { expanded: false }, theme, narrowContext);
	const narrowLine = tools.read.renderCall({ path: "/tmp/project/deep/file.ts" }, theme, narrowContext).render(12)[0];
	expect(visibleWidth(narrowLine)).toBe(12);
	expect(narrowLine).not.toContain("52.0k");

	const directory = await mkdtemp(join(tmpdir(), "tool-renderer-"));
	temporaryDirectories.push(directory);
	const path = join(directory, "timed.txt");
	await writeFile(path, "ok");
	const originalNow = performance.now.bind(performance);
	let nowValues = [0, 1500];
	Object.defineProperty(performance, "now", { configurable: true, value: () => nowValues.shift() ?? 0 });
	try {
		const timedId = "timed-read";
		const timedResult = await tools.read.execute(timedId, { path }, undefined, undefined, { cwd: directory });
		const timedContext = renderContext({ toolCallId: timedId, cwd: directory });
		tools.read.renderResult(timedResult, { expanded: false }, theme, timedContext);
		const timedLine = tools.read.renderCall({ path }, theme, timedContext).render(76)[0];
		expect(timedLine).toContain("1.5s");
		expect(visibleWidth(timedLine)).toBe(76);
		nowValues = [0, 119_500];
		const roundedId = "rounded-read";
		const roundedResult = await tools.read.execute(roundedId, { path }, undefined, undefined, { cwd: directory });
		const roundedContext = renderContext({ toolCallId: roundedId, cwd: directory });
		tools.read.renderResult(roundedResult, { expanded: false }, theme, roundedContext);
		const roundedLine = tools.read.renderCall({ path }, theme, roundedContext).render(76)[0];
		expect(roundedLine).toContain("2m");
		expect(visibleWidth(roundedLine)).toBe(76);
	} finally {
		Object.defineProperty(performance, "now", { configurable: true, value: originalNow });
	}

	const customToolRow = {
		toolName: "subagent",
		toolCallId: "call-1",
		args: { task: "inspect repo structure", depth: 2 },
		isPartial: false,
		expanded: false,
		cwd: "/tmp/project",
		result: { content: [{ type: "text", text: "subagent finished successfully" }], isError: false },
	};
	const fallbackModule = await loadFirecodeModule("tools/grouping.ts");
	const renderedFallback = fallbackModule.renderFallbackToolRow(customToolRow, 76, theme);
	expect(renderedFallback.length).toBe(2);
	expect(renderedFallback[1]).toContain("▏ ✓ subagent task: inspect repo structure");
	expect(visibleWidth(renderedFallback[1])).toBe(76);

	const errorCustomRow = {
		toolName: "web_search",
		toolCallId: "call-2",
		args: { query: "pi mono changelog" },
		isPartial: false,
		expanded: false,
		cwd: "/tmp/project",
		result: { content: [{ type: "text", text: "Network timeout" }], isError: true },
	};
	const renderedError = fallbackModule.renderFallbackToolRow(errorCustomRow, 76, theme);
	expect(renderedError.length).toBe(2);
	expect(renderedError[1]).toContain("▏ ✗ web_search query: pi mono changelog");
	expect(visibleWidth(renderedError[1])).toBe(76);

	const expandedCustomRow = { ...customToolRow, expanded: true };
	const renderedExpanded = fallbackModule.renderFallbackToolRow(expandedCustomRow, 76, theme);
	expect(renderedExpanded.length).toBe(4);
	expect(renderedExpanded[1]).toContain("▏ ✓ subagent task: inspect repo structure");
	expect(renderedExpanded[3]).toContain("subagent finished successfully");

	expect(Object.keys(tools).sort()).toEqual([...toolNames].sort());
});
