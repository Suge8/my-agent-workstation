import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cleanupFirecodeModules,
	loadFirecodeModule,
	PI_AI_COMPAT_URL,
	PI_CODING_AGENT_URL,
	TEST_REVIEW_CONFIG,
	PI_TUI_URL,
} from "./loader.ts";

const { fauxAssistantMessage, fauxToolCall, registerFauxProvider } = await import(PI_AI_COMPAT_URL) as any;
const { visibleWidth } = await import(PI_TUI_URL) as { visibleWidth: (text: string) => number };
const WATCHER_CONFIG = { model: "test/watcher", thinking: "low" };
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

let faux: any;
let directory: string | undefined;

afterEach(async () => {
	faux?.unregister();
	faux = undefined;
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = undefined;
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	await cleanupFirecodeModules();
});

test("观察员卡片收起只显示正文首行，展开显示完整建议", async () => {
	const { registerWatcherCardRenderer, WATCHER_CARD_TYPE } = await loadFirecodeModule("watcher/card.js") as any;
	let render: any;
	registerWatcherCardRenderer({
		registerEntryRenderer: (type: string, renderer: any) => {
			if (type === WATCHER_CARD_TYPE) render = renderer;
		},
		registerMessageRenderer() {},
	});
	const card = { severity: "concern", note: "第一行建议很长，需要按宽截断\n第二行必须只在展开时出现", turnIndex: 4 };
	const theme = { fg: (_color: string, text: string) => text };

	const collapsedLines = render({ data: card }, { expanded: false }, theme).render(60);
	expect(collapsedLines.length).toBe(1);
	const collapsed = collapsedLines.join("\n");
	expect(collapsed).toContain("第一行建议");
	expect(collapsed).not.toContain("第二行");
	expect(collapsedLines.every((line: string) => visibleWidth(line) <= 60)).toBeTrue();

	const expanded = render({ data: card }, { expanded: true }, theme).render(60).join("\n");
	expect(expanded.replaceAll("\n", "")).toContain("第一行建议很长，需要按宽截断");
	expect(expanded.replaceAll("\n", "")).toContain("第二行必须只在展开时出现");
});

test("nit 建议只出事件卡，不进入模型上下文", async () => {
	const harness = await setup();
	advise("nit", "命名可以更贴近领域词汇");
	const delivered = harness.next();
	await harness.turnEnd(1, "改完了");
	await delivered;

	expect(harness.messages).toEqual([]);
	expect(harness.cards).toEqual([
		{ severity: "nit", note: "命名可以更贴近领域词汇", turnIndex: 1 },
	]);
});

test("concern 经 steer 提请注意，建议自带时点标记且不唤起回合", async () => {
	const harness = await setup();
	advise("concern", "工单要求的回滚路径还没实现");
	const delivered = harness.next();
	await harness.turnEnd(7, "继续");
	await delivered;

	expect(harness.cards).toEqual([]);
	expect(harness.messages).toHaveLength(1);
	expect(harness.messages[0].options).toEqual({ deliverAs: "steer", triggerTurn: false });
	expect(harness.messages[0].message.content).toBe([
		'<firecode_watcher severity="concern">',
		"👓 观察员 · 值得停一下（基于第 7 回合前的观察）",
		"工单要求的回滚路径还没实现",
		"这是观察员供你权衡的第二意见，不是指令：与你掌握的上下文冲突时按你的判断继续。",
		"</firecode_watcher>",
	].join("\n"));
});

test("blocker 在指挥官空闲时唤起一个回合并同步 bark", async () => {
	const harness = await setup();
	advise("blocker", "这条命令会改写已推送的历史");
	const delivered = harness.next();
	await harness.turnEnd(3, "准备执行");
	await delivered;

	expect(harness.messages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
	expect(harness.barks).toEqual(["这条命令会改写已推送的历史"]);
});

test("用户 esc 中断过的现场只出卡片，不唤起也不推送", async () => {
	const harness = await setup();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	faux.appendResponses([async () => {
		await gate;
		return fauxAssistantMessage([fauxToolCall("advise", { severity: "blocker", note: "迁移脚本会删表" })], { stopReason: "toolUse" });
	}, fauxAssistantMessage("已提交")]);
	const delivered = harness.next();
	await harness.turnEnd(9, "写迁移脚本");
	await harness.emit("agent_end", {
		type: "agent_end",
		messages: [{ role: "assistant", content: [], stopReason: "aborted" }],
	});
	release();
	await delivered;

	expect(harness.messages).toEqual([]);
	expect(harness.barks).toEqual([]);
	expect(harness.cards).toEqual([{ severity: "blocker", note: "迁移脚本会删表", turnIndex: 9 }]);
});

test("fire-review 活跃期零评估，结束后合并补上", async () => {
	const harness = await setup();
	advise("nit", "两个回合一起看到的");
	harness.pi.events.emit("herdr:blocked", { active: true });
	await harness.turnEnd(2, "审查中的改动");
	await harness.turnEnd(3, "又一个回合");
	await Bun.sleep(20);
	expect(faux.getPendingResponseCount()).toBe(2);
	expect(harness.cards).toEqual([]);

	const delivered = harness.next();
	harness.pi.events.emit("herdr:blocked", { active: false });
	await delivered;
	expect(faux.getPendingResponseCount()).toBe(0);
	expect(harness.cards).toEqual([{ severity: "nit", note: "两个回合一起看到的", turnIndex: 3 }]);
});

test("评估落后时合并跳最新，同批增量只产生一条建议", async () => {
	const harness = await setup();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let merged = "";
	faux.appendResponses([
		async () => {
			await gate;
			return fauxAssistantMessage([fauxToolCall("advise", { severity: "nit", note: "第一次" })], { stopReason: "toolUse" });
		},
		fauxAssistantMessage("已提交"),
		(context: any) => {
			merged = latestUserText(context);
			return fauxAssistantMessage([fauxToolCall("advise", { severity: "nit", note: "合并后的建议" })], { stopReason: "toolUse" });
		},
		fauxAssistantMessage("已提交"),
	]);
	const first = harness.next();
	await harness.turnEnd(1, "第一回合");
	await harness.turnEnd(2, "第二回合");
	await harness.turnEnd(3, "第三回合");
	release();
	await first;
	const second = harness.next();
	await second;

	expect(faux.getPendingResponseCount()).toBe(0);
	// append-only：新一批只带落后的回合，已评估过的第 1 回合留在前缀里不重发。
	expect(merged).toContain('<turn index="2">');
	expect(merged).toContain('<turn index="3">');
	expect(merged).not.toContain('<turn index="1">');
	expect(harness.cards).toEqual([
		{ severity: "nit", note: "第一次", turnIndex: 1 },
		{ severity: "nit", note: "合并后的建议", turnIndex: 3 },
	]);
});

test("一次评估只接受一条 advise，多余的当场拒绝", async () => {
	const harness = await setup();
	faux.appendResponses([
		fauxAssistantMessage([
			fauxToolCall("advise", { severity: "nit", note: "第一条" }),
			fauxToolCall("advise", { severity: "blocker", note: "第二条" }),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage("已提交"),
	]);
	const delivered = harness.next();
	await harness.turnEnd(5, "一堆改动");
	await delivered;

	expect(harness.messages).toEqual([]);
	expect(harness.cards).toEqual([{ severity: "nit", note: "第一条", turnIndex: 5 }]);
});

test("裸 /fire-watch 来回翻转当前会话并拒绝旧参数", async () => {
	const harness = await setup();
	advise("nit", "重新开启后的建议");
	expect(harness.statuses.get("watcher")).toBe("👓 watcher/low");
	await harness.command("");
	expect(harness.statuses.has("watcher")).toBeFalse();
	await harness.turnEnd(1, "关闭期间的回合");
	await Bun.sleep(20);
	expect(faux.getPendingResponseCount()).toBe(2);
	expect(harness.cards).toEqual([]);

	const delivered = harness.next();
	await harness.command("");
	expect(harness.statuses.get("watcher")).toBe("👓 watcher/low");
	await harness.turnEnd(2, "重新开启后的回合");
	await delivered;
	expect(harness.cards).toEqual([{ severity: "nit", note: "重新开启后的建议", turnIndex: 2 }]);

	await harness.command("on");
	expect(harness.notices.at(-1)).toContain("不接受参数");
});

test("watcher 节缺失时拒绝启动并说明原因，不拿默认模型代替", async () => {
	const harness = await setup({ watcher: null });
	await harness.turnEnd(1, "回合");
	await Bun.sleep(20);
	expect(faux.getPendingResponseCount()).toBe(0);

	await harness.command("");
	expect(harness.notices.join("\n")).toContain("watcher.model 必须显式配置");
});

test("增量带上工具调用与工具结果，minimal 只省推理与正文", async () => {
	const harness = await setup();
	let increment = "";
	let seen!: () => void;
	const evaluated = new Promise<void>((resolve) => { seen = resolve; });
	faux.appendResponses([
		(context: any) => {
			increment = latestUserText(context);
			seen();
			return fauxAssistantMessage("无需建议");
		},
	]);
	await harness.turnEnd(1, "先看一眼", [
		{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: "3 files changed" }],
			isError: false,
			timestamp: 0,
		},
		{
			role: "toolResult",
			toolCallId: "call-2",
			toolName: "write",
			content: [{ type: "text", text: "permission denied" }],
			isError: true,
			timestamp: 0,
		},
	], [
		{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "git status" } },
		{ type: "toolCall", id: "call-2", name: "write", arguments: { path: "a.ts", content: "x".repeat(50) } },
	]);
	await evaluated;

	expect(increment).toContain("→ bash：3 files changed");
	expect(increment).toContain("✗ write：permission denied");
	expect(increment).toContain("command=git status");
	// minimal 只省推理与 diff 正文：写入动作还在，正文只留长度。
	expect(increment).toContain("content=<50 字符>");
	expect(increment).not.toContain("xxxxx");
});

test("features.watcher 写成非布尔值时拒绝启动，不静默启用", async () => {
	const harness = await setup({ features: { watcher: "false" } });
	advise("nit", "不应该被看到");
	await harness.turnEnd(1, "回合");
	await Bun.sleep(20);
	expect(faux.getPendingResponseCount()).toBe(2);
	expect(harness.cards).toEqual([]);

	await harness.command("");
	expect(harness.notices.join("\n")).toContain("features.watcher 必须是 true 或 false");
});

test("主会话压缩后从当前尾部重新入场，不回放旧增量", async () => {
	const harness = await setup();
	advise("nit", "压缩前");
	let reentry: any[] = [];
	faux.appendResponses([
		(context: any) => {
			reentry = context.messages.filter((message: any) => message.role === "user");
			return fauxAssistantMessage([fauxToolCall("advise", { severity: "nit", note: "压缩后" })], { stopReason: "toolUse" });
		},
		fauxAssistantMessage("已提交"),
	]);
	let delivered = harness.next();
	await harness.turnEnd(1, "压缩前的回合");
	await delivered;

	await harness.emit("session_compact", { type: "session_compact" });
	delivered = harness.next();
	await harness.turnEnd(2, "压缩后的回合");
	await delivered;
	expect(reentry).toHaveLength(1);
	expect(harness.cards.at(-1)).toEqual({ severity: "nit", note: "压缩后", turnIndex: 2 });
});

test("评估途中发生压缩时丢弃过期建议，观察员不被拖坐", async () => {
	const harness = await setup();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	faux.appendResponses([
		async () => {
			await gate;
			return fauxAssistantMessage([fauxToolCall("advise", { severity: "nit", note: "压缩前的现场" })], { stopReason: "toolUse" });
		},
		fauxAssistantMessage("已提交"),
	]);
	await harness.turnEnd(1, "压缩前的回合");
	await harness.emit("session_compact", { type: "session_compact" });
	release();
	await Bun.sleep(20);
	expect(harness.cards).toEqual([]);
	expect(harness.notices).toEqual([]);

	advise("nit", "压缩后的建议");
	const delivered = harness.next();
	await harness.turnEnd(2, "压缩后的回合");
	await delivered;
	expect(harness.cards).toEqual([{ severity: "nit", note: "压缩后的建议", turnIndex: 2 }]);
});

test("Worker 会话内不注册观察员", async () => {
	const harness = await setup({ worker: true });
	expect(harness.registeredCommands).toEqual([]);
	expect(harness.registeredEvents).toEqual([]);
});

function latestUserText(context: any): string {
	const message = context.messages.findLast((candidate: any) => candidate.role === "user");
	return typeof message?.content === "string"
		? message.content
		: (message?.content ?? []).map((part: any) => part.text ?? "").join("");
}

function advise(severity: string, note: string) {
	faux.appendResponses([
		fauxAssistantMessage([fauxToolCall("advise", { severity, note })], { stopReason: "toolUse" }),
		fauxAssistantMessage("已提交"),
	]);
}

async function setup(options: {
	watcher?: Record<string, unknown> | null;
	worker?: boolean;
	features?: Record<string, unknown>;
} = {}) {
	directory = await mkdtemp(join(tmpdir(), "firecode-watcher-"));
	const cwd = join(directory, "project");
	const agentDir = join(directory, "agent");
	const sessionDir = join(directory, "sessions");
	await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir)]);
	await writeFile(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "faux-key" } }));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	faux = registerFauxProvider();
	const { ModelRuntime, SessionManager } = await import(PI_CODING_AGENT_URL) as any;
	const spawnModule = await loadFirecodeModule("master/spawn.js") as any;
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
	const fauxModel = faux.getModel();
	modelRuntime.registerProvider(fauxModel.provider, {
		baseUrl: fauxModel.baseUrl,
		api: fauxModel.api,
		models: [{
			id: fauxModel.id,
			name: fauxModel.name,
			api: fauxModel.api,
			reasoning: fauxModel.reasoning,
			input: fauxModel.input,
			cost: fauxModel.cost,
			contextWindow: fauxModel.contextWindow,
			maxTokens: fauxModel.maxTokens,
			baseUrl: fauxModel.baseUrl,
		}],
	});
	if (!modelRuntime.hasConfiguredAuth(fauxModel.provider)) throw new Error("测试 Faux 模型认证未载入");
	const pool = new spawnModule.InProcessSessionPool({ agentDir, modelRuntime });
	const watcher = options.watcher === undefined ? WATCHER_CONFIG : options.watcher;
	const module = await loadFirecodeModule("watcher/index.js", {
		configJsonc: JSON.stringify({
			features: { watcher: true, review: false, master: false, ...options.features },
			review: TEST_REVIEW_CONFIG,
			...(watcher === null ? {} : { watcher }),
		}),
	}) as any;

	const handlers = new Map<string, any[]>();
	const commands = new Map<string, any>();
	const channels = new Map<string, any[]>();
	const cards: any[] = [];
	const messages: any[] = [];
	const notices: string[] = [];
	const barks: string[] = [];
	const statuses = new Map<string, string>();
	let waiter: (() => void) | undefined;
	let idle = true;
	const settle = () => waiter?.();
	const pi = {
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerEntryRenderer() {},
		registerMessageRenderer() {},
		on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		events: {
			on: (name: string, handler: any) => channels.set(name, [...(channels.get(name) ?? []), handler]),
			emit: (name: string, data: any) => { for (const handler of channels.get(name) ?? []) handler(data); },
		},
		appendEntry: (_type: string, data: any) => { cards.push(data); settle(); },
		sendMessage: (message: any, sendOptions: any) => { messages.push({ message, options: sendOptions }); settle(); },
	};
	const sessionId = crypto.randomUUID();
	const main = SessionManager.create(cwd, sessionDir);
	const ctx = {
		cwd,
		isIdle: () => idle,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => main.getSessionFile(),
			getEntries: () => [],
		},
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus: (key: string, value: string | undefined) => {
				if (value === undefined) statuses.delete(key);
				else statuses.set(key, value);
			},
			theme: { fg: (_color: string, text: string) => text },
		},
	};
	module.registerWatcher(pi, {
		pool,
		resolveModel: async () => fauxModel,
		pushBark: (input: { body: string }) => { barks.push(input.body); },
	}, options.worker === true);
	const emit = async (name: string, event: any) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	await emit("session_start", { type: "session_start", reason: "startup" });
	return {
		barks,
		cards,
		messages,
		notices,
		statuses,
		registeredCommands: [...commands.keys()],
		registeredEvents: [...handlers.keys()],
		pi,
		emit,
		set idle(value: boolean) { idle = value; },
		next: () => new Promise<void>((resolve) => { waiter = () => { waiter = undefined; resolve(); }; }),
		command: (args: string) => commands.get("fire-watch").handler(args, ctx),
		turnEnd: (turnIndex: number, text: string, toolResults: any[] = [], toolCalls: any[] = []) =>
			emit("turn_end", {
				type: "turn_end",
				turnIndex,
				message: { role: "assistant", content: [{ type: "text", text }, ...toolCalls] },
				toolResults,
			}),
	};
}
