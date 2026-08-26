import { afterEach, describe, expect, test } from "bun:test";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader.ts";

type Progress = typeof import("../review/progress.js");

async function loadProgress(): Promise<Progress> {
	return (await loadFirecodeModule("review/progress.js")) as Progress;
}

const reviewers = [{ model: "openai-codex/gpt-5.6-sol" }, { model: "openai-codex/gpt-5.6-luna" }];

afterEach(cleanupFirecodeModules);

describe("reviewer progress derived from structured session events", () => {
	test("starts every reviewer as running with a readable label", async () => {
		const { initialProgress } = await loadProgress();
		const progress = initialProgress(reviewers, "zh");
		expect(progress.map((item) => item.label)).toEqual(["gpt-5.6-sol", "gpt-5.6-luna"]);
		expect(progress.every((item) => item.status === "running")).toBe(true);
		expect(progress[0].action).toBe("思考中");
	});

	test("turns tool calls into human actions and counts them per reviewer", async () => {
		const { applySessionEvent, initialProgress } = await loadProgress();
		let progress = initialProgress(reviewers, "zh");
		progress = applySessionEvent(
			progress,
			0,
			{ type: "tool_execution_start", toolName: "read", args: { path: "agent/review/state.ts" } },
			"zh",
		);
		progress = applySessionEvent(
			progress,
			0,
			{ type: "tool_execution_start", toolName: "bash", args: { command: "bun test  x" } },
			"zh",
		);
		expect(progress[0].action).toBe("跑 bun test x");
		expect(progress[0].toolCalls).toBe(2);
		expect(progress[0].trail).toEqual(["读 review/state.ts", "跑 bun test x"]);
		// 其他审查者不受影响
		expect(progress[1].toolCalls).toBe(0);
	});

	test("tracks tool completion and token usage for progress monitoring", async () => {
		const { applySessionEvent, initialProgress } = await loadProgress();
		let progress = initialProgress(reviewers, "zh");
		progress = applySessionEvent(progress, 0, {
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "read",
			args: { path: "review/state.ts" },
		}, "zh");
		progress = applySessionEvent(progress, 0, {
			type: "tool_execution_end",
			toolCallId: "call-1",
		}, "zh");
		progress = applySessionEvent(progress, 0, {
			type: "message_end",
			message: { usage: { totalTokens: 1250 } },
		}, "zh");
		expect(progress[0].activeTools).toEqual([]);
		expect(progress[0].recentTools[0]).toMatchObject({ tool: "read", args: "review/state.ts" });
		expect(progress[0].tokens).toBe(1250);
	});

	test("ignores non-tool events so the bar does not churn", async () => {
		const { applySessionEvent, initialProgress } = await loadProgress();
		const progress = initialProgress(reviewers, "zh");
		const next = applySessionEvent(progress, 0, { type: "message_update" }, "zh");
		expect(next).toBe(progress);
	});

	test("settling replaces the action with the verdict and extracts details from realistic output", async () => {
		const { initialProgress, settleProgress } = await loadProgress();
		let progress = initialProgress(reviewers, "zh");
		const rawFail = `FAIL\n\n## 发现 1：状态竞态\n- **严重程度**: 高\n- **问题**:\n并发写入导致丢失\n- **违反的约定与期望行为**:\n原子写入\n- **证据**:\nx\n- **验证命令**:\ny`;
		progress = settleProgress(
			progress,
			1,
			"failed",
			"zh",
			"发现 1 项问题",
			rawFail,
		);
		expect(progress[1].status).toBe("failed");
		expect(progress[1].action).toBe("发现问题");
		expect(progress[1].details).not.toContain("FAIL");
		// 首行数量汇总 + 每发现一行带严重度标签的标题；问题正文不进活动条。
		expect(progress[1].details?.[0]).toBe("发现 1 个问题");
		expect(progress[1].details).toContain("[严重·高] 状态竞态");
		expect(progress[1].details?.join("\n")).not.toContain("问题: 并发写入导致丢失");
		// 每模型自己的耗时：启动时刻来自 initialProgress，落定时刻冻结在 settle。
		expect(progress[1].startedAt).toBeGreaterThan(0);
		expect(progress[1].settledAt).toBeGreaterThanOrEqual(progress[1].startedAt);
		expect(progress[0].settledAt).toBeUndefined();
		expect(progress[0].status).toBe("running");
	});

	test("extracts suggestions in PASS output with summary first", async () => {
		const { extractReviewDetails } = await loadProgress();
		const raw = `PASS\n验证命令 exit 0，核心逻辑已核对。\n证据：文件=a.ts；命令=bun test\n\n## 建议（非阻塞）\n- 可为超时边界补充测试用例`;
		const details = extractReviewDetails("passed", "验证命令 exit 0，核心逻辑已核对。", raw, "zh");
		expect(details[0]).toBe("验证命令 exit 0，核心逻辑已核对。");
		expect(details).toContain("建议：可为超时边界补充测试用例");
	});
});

describe("review activity layout", () => {
	test("matches the pi-flow bordered quality box with flame, rows, and hint", async () => {
		const ui = (await loadFirecodeModule("review/ui.js")) as {
			showActivity: (ctx: unknown, view: unknown) => void;
		};
		let factory: ((tui: unknown, theme: unknown) => { render: (width: number) => string[]; dispose: () => void }) | undefined;
		ui.showActivity(
			{ ui: { setWidget: (_key: string, next: typeof factory) => { factory = next; } } },
			() => ({
				phase: "reviewing",
				round: 1,
				focus: "",
				roundStartedAt: 0,
				advisorRunning: false,
				language: "zh",
				reviewers: [
					{ index: 0, label: "gpt-5.6-sol", status: "running", action: "读 review/state.ts", toolCalls: 2, trail: [], startedAt: Date.now() - 96_000 },
					{
						index: 1,
						label: "gpt-5.6-terra",
						status: "failed",
						action: "发现问题",
						summary: "审查未通过",
						details: ["审查未通过", "↳ [高] 结算态丢失完整结果"],
						toolCalls: 3,
						trail: [],
					},
				],
			}),
		);
		const component = factory?.(
			{ requestRender: () => {} },
			{ fg: (_tone: string, text: string) => text },
		);
		const lines = component?.render(100) ?? [];
		const output = lines.join("\n");
		expect(output).toContain("🔥 审查中");
		// 运行中模型带自己的耗时；未设 startedAt 的其他 fixture 不显示。
		expect(output).toMatch(/gpt-5\.6-sol · 2 次调用 · 1m3\ds/u);
		expect(output).toContain("读 review/state");
		expect(output).toContain("❌ gpt-5.6-terra");
		expect(output).toContain("[高] 结算态丢失完整结果");
		expect(output).toContain("Esc/Ctrl+C 取消");
		expect(lines[0].replace(/\x1b\[[0-9;]*m/gu, "")).toBe("─".repeat(100));
		expect(lines.at(-1)?.replace(/\x1b\[[0-9;]*m/gu, "")).toBe("─".repeat(100));
		component?.dispose();
	});

	test("compacts to single line per reviewer when reviewers exceed 3", async () => {
		const ui = (await loadFirecodeModule("review/ui.js")) as {
			showActivity: (ctx: unknown, view: unknown) => void;
		};
		let factory: ((tui: unknown, theme: unknown) => { render: (width: number) => string[]; dispose: () => void }) | undefined;
		ui.showActivity(
			{ ui: { setWidget: (_key: string, next: typeof factory) => { factory = next; } } },
			() => ({
				phase: "reviewing",
				round: 1,
				focus: "",
				roundStartedAt: 0,
				advisorRunning: false,
				language: "zh",
				reviewers: [
					{ index: 0, label: "model-1", status: "passed", action: "通过", summary: "通过核验", details: ["通过核验"], toolCalls: 1, trail: [] },
					{ index: 1, label: "model-2", status: "passed", action: "通过", summary: "通过核验", details: ["通过核验"], toolCalls: 1, trail: [] },
					{ index: 2, label: "model-3", status: "passed", action: "通过", summary: "通过核验", details: ["通过核验"], toolCalls: 1, trail: [] },
					{ index: 3, label: "model-4", status: "failed", action: "发现问题", summary: "未通过", details: ["[高] 发现 4"], toolCalls: 1, trail: [] },
				],
			}),
		);
		const component = factory?.(
			{ requestRender: () => {} },
			{ fg: (_tone: string, text: string) => text },
		);
		const output = (component?.render(64) ?? []).join("\n");
		expect(output).toContain("✅ model-1 · 通过核验");
		expect(output).toContain("❌ model-4 · [高] 发现 4");
		// 4个模型紧凑单行，不带双行箭头
		expect(output).not.toContain("  ↳");
		component?.dispose();
	});

	test("advisor verdict summary stays visible in the repair phase activity bar", async () => {
		const ui = (await loadFirecodeModule("review/ui.js")) as {
			showActivity: (ctx: unknown, view: unknown) => void;
		};
		let factory: ((tui: unknown, theme: unknown) => { render: (width: number) => string[]; dispose: () => void }) | undefined;
		const renderWith = (progressKind: string | undefined, summary: string) => {
			ui.showActivity(
				{ ui: { setWidget: (_key: string, next: typeof factory) => { factory = next; } } },
				() => ({
					phase: "awaiting_fix",
					round: 2,
					focus: "",
					roundStartedAt: 0,
					advisorRunning: false,
					language: "zh",
					progressKind,
					reviewers: [{ index: 0, label: "claude-fable-5", status: "passed", action: "通过", summary, toolCalls: 1, trail: [] }],
				}),
			);
			const component = factory?.({ requestRender: () => {} }, { fg: (_tone: string, text: string) => text });
			const output = (component?.render(80) ?? []).join("\n");
			component?.dispose();
			return output;
		};
		const withAdvisor = renderWith("advisor", "继续修复：settled 竞态属实");
		expect(withAdvisor).toContain("正在修复第 2 轮审查反馈");
		expect(withAdvisor).toContain("💡 继续修复：settled 竞态属实");
		expect(renderWith("reviewers", "核心逻辑已核对")).not.toContain("💡");
	});

	test("advisor consultation phase displays advisor consulting title and live advisor progress", async () => {
		const ui = (await loadFirecodeModule("review/ui.js")) as {
			showActivity: (ctx: unknown, view: unknown) => void;
		};
		let factory: ((tui: unknown, theme: unknown) => { render: (width: number) => string[]; dispose: () => void }) | undefined;
		ui.showActivity(
			{ ui: { setWidget: (_key: string, next: typeof factory) => { factory = next; } } },
			() => ({
				phase: "needs_fix",
				round: 2,
				focus: "",
				roundStartedAt: 0,
				advisorRunning: true,
				language: "zh",
				consecutiveFailures: 2,
				reviewers: [{
					index: 0,
					label: "claude-fable-5",
					status: "running",
					action: "跑 bun test tests/review-ui.test.ts",
					toolCalls: 2,
					recentTools: [{ id: "t1", tool: "read", args: "review/state.ts", startedAt: 1, endedAt: 2 }],
					trail: [],
				}],
			}),
		);
		const component = factory?.(
			{ requestRender: () => {} },
			{ fg: (_tone: string, text: string) => text },
		);
		const output = (component?.render(80) ?? []).join("\n");
		expect(output).toContain("🔥 顾问介入中 · 连续 2 轮未过");
		expect(output).toContain("顾问 claude-fable-5 · 2 次调用");
		// 动作按时间顺序滚动：旧在上新在下，不标当前/历史。
		expect(output).toContain("↳ 读 state.ts");
		expect(output).toContain("↳ 跑 bun test");
		expect(output).not.toContain("当前:");
		expect(output).toContain("Esc/Ctrl+C 跳过咨询");
		component?.dispose();
	});

	test("small reviewer count (<=3) unfolds multiline details and tool history without losing summary", async () => {
		const ui = (await loadFirecodeModule("review/ui.js")) as {
			showActivity: (ctx: unknown, view: unknown) => void;
		};
		let factory: ((tui: unknown, theme: unknown) => { render: (width: number) => string[]; dispose: () => void }) | undefined;
		ui.showActivity(
			{ ui: { setWidget: (_key: string, next: typeof factory) => { factory = next; } } },
			() => ({
				phase: "reviewing",
				round: 1,
				focus: "",
				roundStartedAt: 0,
				advisorRunning: false,
				language: "zh",
				reviewers: [
					{
						index: 0,
						label: "gpt-5.6-terra",
						status: "passed",
						action: "通过",
						summary: "核心逻辑与测试已通过",
						details: ["核心逻辑与测试已通过", "↳ 建议：可为边界场景补充单测"],
						toolCalls: 3,
						trail: [],
					},
					{
						index: 1,
						label: "gpt-5.6-sol",
						status: "failed",
						action: "发现问题",
						summary: "未通过",
						details: ["↳ [高] 结算态丢失完整结果", "↳ 问题: 大屏仍只显示标题，不展示这段核心问题说明"],
						toolCalls: 3,
						trail: [],
					},
				],
			}),
		);
		const component = factory?.(
			{ requestRender: () => {} },
			{ fg: (_tone: string, text: string) => text },
		);
		const output = (component?.render(80) ?? []).join("\n");
		// PASS 保留核心摘要，同时附带建议
		expect(output).toContain("✅ gpt-5.6-terra");
		expect(output).toContain("核心逻辑与测试已通过");
		expect(output).toContain("建议：可为边界场景补充单测");
		// FAIL 展示标题与问题正文
		expect(output).toContain("❌ gpt-5.6-sol");
		expect(output).toContain("[高] 结算态丢失完整结果");
		expect(output).toContain("问题: 大屏仍只显示标题");
		component?.dispose();
	});

	test("honors terminal height budget under 12-row terminal with 5 reviewers", async () => {
		const ui = (await loadFirecodeModule("review/ui.js")) as {
			showActivity: (ctx: unknown, view: unknown) => void;
		};
		let factory: ((tui: unknown, theme: unknown) => { render: (width: number) => string[]; dispose: () => void }) | undefined;
		ui.showActivity(
			{ ui: { setWidget: (_key: string, next: typeof factory) => { factory = next; } } },
			() => ({
				phase: "reviewing",
				round: 1,
				focus: "",
				roundStartedAt: 0,
				advisorRunning: false,
				language: "zh",
				reviewers: Array.from({ length: 5 }, (_, i) => ({
					index: i,
					label: `model-${i + 1}`,
					status: "running",
					action: `读 state-${i + 1}.ts`,
					toolCalls: 2,
					trail: [],
				})),
			}),
		);
		const component = factory?.(
			{ requestRender: () => {}, terminal: { columns: 64, rows: 12 } },
			{ fg: (_tone: string, text: string) => text },
		);
		const lines = component?.render(64) ?? [];
		// 12 * 0.7 = 8 行
		expect(lines.length).toBeLessThanOrEqual(Math.floor(12 * 0.7));
		const output = lines.join("\n");
		for (let i = 1; i <= 5; i += 1) {
			expect(output).toContain(`model-${i}`);
		}
		component?.dispose();
	});

	test("retains all 5 reviewers in compact single-line mode under 10-row terminal", async () => {
		const ui = (await loadFirecodeModule("review/ui.js")) as {
			showActivity: (ctx: unknown, view: unknown) => void;
		};
		let factory: ((tui: unknown, theme: unknown) => { render: (width: number) => string[]; dispose: () => void }) | undefined;
		ui.showActivity(
			{ ui: { setWidget: (_key: string, next: typeof factory) => { factory = next; } } },
			() => ({
				phase: "reviewing",
				round: 1,
				focus: "",
				roundStartedAt: 0,
				advisorRunning: false,
				language: "zh",
				reviewers: Array.from({ length: 5 }, (_, i) => ({
					index: i,
					label: `model-${i + 1}`,
					status: "running",
					action: `读 state-${i + 1}.ts`,
					toolCalls: 2,
					trail: [],
				})),
			}),
		);
		const component = factory?.(
			{ requestRender: () => {}, terminal: { columns: 64, rows: 10 } },
			{ fg: (_tone: string, text: string) => text },
		);
		const lines = component?.render(64) ?? [];
		// 10 * 0.7 = 7 行
		expect(lines.length).toBeLessThanOrEqual(Math.floor(10 * 0.7));
		const output = lines.join("\n");
		for (let i = 1; i <= 5; i += 1) {
			expect(output).toContain(`model-${i}`);
		}
		component?.dispose();
	});

	test("strictly honors height budget under ultra-low 4-row terminal with all 5 reviewers visible", async () => {
		const ui = (await loadFirecodeModule("review/ui.js")) as {
			showActivity: (ctx: unknown, view: unknown) => void;
		};
		let factory: ((tui: unknown, theme: unknown) => { render: (width: number) => string[]; dispose: () => void }) | undefined;
		ui.showActivity(
			{ ui: { setWidget: (_key: string, next: typeof factory) => { factory = next; } } },
			() => ({
				phase: "reviewing",
				round: 1,
				focus: "",
				roundStartedAt: 0,
				advisorRunning: false,
				language: "zh",
				reviewers: [
					{ index: 0, label: "gpt-5.6-sol", status: "running", action: "读 state.ts", toolCalls: 1, trail: [] },
					{ index: 1, label: "gpt-5.6-terra", status: "running", action: "跑测试", toolCalls: 1, trail: [] },
					{ index: 2, label: "gpt-5.6-luna", status: "passed", action: "通过", toolCalls: 1, trail: [] },
					{ index: 3, label: "claude-3-7-sonnet", status: "running", action: "读 index.ts", toolCalls: 1, trail: [] },
					{ index: 4, label: "gemini-2.5-pro", status: "passed", action: "通过", toolCalls: 1, trail: [] },
				],
			}),
		);
		const component = factory?.(
			{ requestRender: () => {}, terminal: { columns: 36, rows: 4 } },
			{ fg: (_tone: string, text: string) => text },
		);
		const lines = component?.render(36) ?? [];
		// 4 * 0.7 = 2 行
		expect(lines.length).toBeLessThanOrEqual(Math.floor(4 * 0.7));
		const output = lines.join("\n");
		expect(output).toContain("sol");
		expect(output).toContain("terra");
		expect(output).toContain("luna");
		expect(output).toContain("c37");
		expect(output).toContain("g25");
		component?.dispose();
	});

	// 紧凑单行与极矮纵向路径同样携带每模型耗时：落定冻结、运行走表。
	test("compact single-line and ultra-short paths carry per-model elapsed", async () => {
		const ui = (await loadFirecodeModule("review/ui.js")) as {
			showActivity: (ctx: unknown, view: unknown) => void;
		};
		let factory: ((tui: unknown, theme: unknown) => { render: (width: number) => string[]; dispose: () => void }) | undefined;
		const reviewer = (index: number, over: Record<string, unknown>) => ({
			index,
			label: `model-${index + 1}`,
			summary: "",
			toolCalls: 2,
			trail: [],
			startedAt: Date.now() - 96_000,
			...over,
		});
		const renderAt = (rows: number) => {
			ui.showActivity(
				{ ui: { setWidget: (_key: string, next: typeof factory) => { factory = next; } } },
				() => ({
					phase: "reviewing",
					round: 1,
					focus: "",
					roundStartedAt: 0,
					advisorRunning: false,
					language: "zh",
					reviewers: [
						reviewer(0, { status: "passed", details: ["通过"], settledAt: Date.now() - 6_000 }),
						reviewer(1, { status: "running", action: "跑 test" }),
						reviewer(2, { status: "running", action: "读 a.ts" }),
						reviewer(3, { status: "running", action: "思考中" }),
					],
				}),
			);
			const component = factory?.(
				{ requestRender: () => {}, terminal: { rows } },
				{ fg: (_tone: string, text: string) => text },
			);
			const output = (component?.render(120) ?? []).join("\n");
			component?.dispose();
			return output;
		};
		// 落定单行（>3 人的 !multiline 路径）：冻结在 1m30s，不随渲染走表。
		const tall = renderAt(40);
		expect(tall).toMatch(/✅ model-1 · 通过 · 1m30s/u);
		expect(tall).toMatch(/model-2 · 跑 test · 2 次调用 · 1m3\ds/u);
		// 极矮纵向路径同样携带。
		const short = renderAt(8);
		expect(short).toMatch(/✅ model-1: 通过 · 1m30s/u);
	});

	// 预算 3…n 行的中间地带曾静默丢审查者：按行分组压缩后全员必须在场。
	test("6-row terminal groups reviewers per line without dropping any", async () => {
		const ui = (await loadFirecodeModule("review/ui.js")) as {
			showActivity: (ctx: unknown, view: unknown) => void;
		};
		let factory: ((tui: unknown, theme: unknown) => { render: (width: number) => string[]; dispose: () => void }) | undefined;
		ui.showActivity(
			{ ui: { setWidget: (_key: string, next: typeof factory) => { factory = next; } } },
			() => ({
				phase: "reviewing",
				round: 1,
				focus: "",
				roundStartedAt: 0,
				advisorRunning: false,
				language: "zh",
				reviewers: Array.from({ length: 5 }, (_, i) => ({
					index: i,
					label: `model-${i + 1}`,
					status: "running",
					action: `action-${i + 1}`,
					summary: "",
					toolCalls: 1,
					tokens: 0,
					activeTools: [],
					recentTools: [],
					trail: [],
				})),
			}),
		);
		const component = factory?.(
			{ requestRender: () => {}, terminal: { columns: 64, rows: 6 } },
			{ fg: (_tone: string, text: string) => text },
		);
		const lines = component?.render(64) ?? [];
		expect(lines.length).toBeLessThanOrEqual(Math.floor(6 * 0.7));
		const output = lines.join("\n");
		for (let i = 1; i <= 5; i += 1) expect(output).toContain(`model-${i}`);
		component?.dispose();
	});

	test("unfolds all 3 settled reviewers with findings and issues under 64x15 terminal", async () => {
		const ui = (await loadFirecodeModule("review/ui.js")) as {
			showActivity: (ctx: unknown, view: unknown) => void;
		};
		let factory: ((tui: unknown, theme: unknown) => { render: (width: number) => string[]; dispose: () => void }) | undefined;
		ui.showActivity(
			{ ui: { setWidget: (_key: string, next: typeof factory) => { factory = next; } } },
			() => ({
				phase: "reviewing",
				round: 1,
				focus: "",
				roundStartedAt: 0,
				advisorRunning: false,
				language: "zh",
				reviewers: [
					{ index: 0, label: "gpt-5.6-sol", status: "failed", summary: "未通过", details: ["[高] 发现 1", "问题: 说明 1"], toolCalls: 1, trail: [] },
					{ index: 1, label: "gpt-5.6-terra", status: "failed", summary: "未通过", details: ["[高] 发现 2", "问题: 说明 2"], toolCalls: 1, trail: [] },
					{ index: 2, label: "gpt-5.6-luna", status: "failed", summary: "未通过", details: ["[高] 发现 3", "问题: 说明 3"], toolCalls: 1, trail: [] },
				],
			}),
		);
		const component = factory?.(
			{ requestRender: () => {}, terminal: { columns: 64, rows: 15 } },
			{ fg: (_tone: string, text: string) => text },
		);
		const lines = component?.render(64) ?? [];
		expect(lines.length).toBeLessThanOrEqual(Math.floor(15 * 0.7));
		const output = lines.join("\n");
		expect(output).toContain("gpt-5.6-sol · [高] 发现 1");
		expect(output).toContain("问题: 说明 1");
		expect(output).toContain("gpt-5.6-terra · [高] 发现 2");
		expect(output).toContain("问题: 说明 2");
		expect(output).toContain("gpt-5.6-luna · [高] 发现 3");
		expect(output).toContain("问题: 说明 3");
		component?.dispose();
	});

	test("honors 5-row budget under 36x8 terminal and displays reviewers in full width", async () => {
		const ui = (await loadFirecodeModule("review/ui.js")) as {
			showActivity: (ctx: unknown, view: unknown) => void;
		};
		let factory: ((tui: unknown, theme: unknown) => { render: (width: number) => string[]; dispose: () => void }) | undefined;
		ui.showActivity(
			{ ui: { setWidget: (_key: string, next: typeof factory) => { factory = next; } } },
			() => ({
				phase: "reviewing",
				round: 1,
				focus: "",
				roundStartedAt: 0,
				advisorRunning: false,
				language: "zh",
				reviewers: [
					{ index: 0, label: "gpt-5.6-sol", status: "running", action: "读 state.ts", toolCalls: 1, trail: [] },
					{ index: 1, label: "gpt-5.6-terra", status: "running", action: "跑测试", toolCalls: 1, trail: [] },
					{ index: 2, label: "gpt-5.6-luna", status: "passed", action: "通过", details: ["验证通过"], toolCalls: 1, trail: [] },
					{ index: 3, label: "claude-3-7-sonnet", status: "running", action: "读 index.ts", toolCalls: 1, trail: [] },
					{ index: 4, label: "gemini-2.5-pro", status: "passed", action: "通过", details: ["核验通过"], toolCalls: 1, trail: [] },
				],
			}),
		);
		const component = factory?.(
			{ requestRender: () => {}, terminal: { columns: 36, rows: 8 } },
			{ fg: (_tone: string, text: string) => text },
		);
		const lines = component?.render(36) ?? [];
		// 8 * 0.7 = 5 行
		expect(lines.length).toBeLessThanOrEqual(Math.floor(8 * 0.7));
		const output = lines.join("\n");
		expect(output).toContain("sol");
		expect(output).toContain("terra");
		expect(output).toContain("luna");
		expect(output).toContain("c37");
		expect(output).toContain("g25");
		component?.dispose();
	});
});

describe("review editor locks input and routes control keys", () => {
	async function makeEditor(language: "zh" | "en" = "zh") {
		const ui = (await loadFirecodeModule("review/ui.js")) as {
			lockEditor: (ctx: unknown, view: unknown, cancel: () => void) => void;
			unlockEditor: (ctx: unknown) => void;
		};
		const events: string[] = [];
		let factory: ((tui: unknown, theme: unknown, keys: unknown) => unknown) | undefined;
		const ctx = {
			ui: {
				setEditorComponent: (next?: (tui: unknown, theme: unknown, keys: unknown) => unknown) => {
					factory = next;
				},
				custom: async () => undefined,
			},
		};
		ui.lockEditor(ctx, () => ({ language, phase: "reviewing", round: 1 }), () =>
			events.push("cancel"),
		);
		const tui = { requestRender: () => {}, addInputListener: () => () => {} };
		const theme = { borderColor: (text: string) => text, selectList: {} };
		const keys = { matches: (data: string, action: string) => action === "app.interrupt" && data === "\x1b" };
		const editor = factory?.(tui, theme, keys) as {
			handleInput: (data: string) => void;
			render: (width: number) => string[];
			getText: () => string;
		};
		return { editor, events, ctx, ui, hasFactory: () => factory !== undefined };
	}

	test("typing does not reach the editor buffer", async () => {
		const { editor } = await makeEditor();
		editor.handleInput("这段字不该出现");
		expect(editor.getText()).toBe("");
	});

	test("escape triggers cancel instantly and reliably", async () => {
		const { editor, events } = await makeEditor();
		editor.handleInput("\x1b");
		expect(events).toEqual(["cancel"]);
	});

	test("hides the editor completely while quality checks run", async () => {
		const { editor } = await makeEditor("en");
		expect(editor.render(80)).toEqual([]);
	});

	test("unlock restores the default editor", async () => {
		const { ctx, ui } = await makeEditor();
		let reset: unknown = "not-called";
		ctx.ui.setEditorComponent = (next?: unknown) => {
			reset = next;
		};
		ui.unlockEditor(ctx);
		expect(reset).toBeUndefined();
	});
});
