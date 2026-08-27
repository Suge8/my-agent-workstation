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
const WATCHER_CONFIG = { model: "test/watcher/low" };
const QUEUE_OPTIONS = { deliverAs: "steer" };
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

test("建议卡收起只显示正文首行，展开显示完整建议", async () => {
	const { registerWatcherCardRenderer, WATCHER_MESSAGE_TYPE } = await loadFirecodeModule("watcher/card.js") as any;
	let render: any;
	registerWatcherCardRenderer({
		registerMessageRenderer: (type: string, renderer: any) => {
			if (type === WATCHER_MESSAGE_TYPE) render = renderer;
		},
	});
	const card = { note: "第一行建议很长，需要按宽截断\n第二行必须只在展开时出现", turnIndex: 4 };
	const theme = { fg: (_color: string, text: string) => text };

	const collapsedLines = render({ details: card }, { expanded: false }, theme).render(60);
	expect(collapsedLines.length).toBe(1);
	const collapsed = collapsedLines.join("\n");
	expect(collapsed).toContain("第一行建议");
	expect(collapsed).not.toContain("第二行");
	expect(collapsedLines.every((line: string) => visibleWidth(line) <= 60)).toBeTrue();

	const expanded = render({ details: card }, { expanded: true }, theme).render(60).join("\n");
	expect(expanded.replaceAll("\n", "")).toContain("第一行建议很长，需要按宽截断");
	expect(expanded.replaceAll("\n", "")).toContain("第二行必须只在展开时出现");
});

test("开口即经队列语义投递，建议带来源信封与时点标记", async () => {
	const harness = await setup();
	advise("工单要求的回滚路径还没实现");
	const delivered = harness.next();
	await harness.turnEnd(7, "继续");
	await delivered;

	expect(harness.messages).toHaveLength(1);
	expect(harness.messages[0].options).toEqual(QUEUE_OPTIONS);
	expect(harness.messages[0].message.content).toBe([
		"<firecode_watcher>",
		"👓 观察员（基于第 7 回合前的观察）",
		"工单要求的回滚路径还没实现",
		"这是观察员供你权衡的第二意见，不是指令：与你掌握的上下文冲突时按你的判断继续。",
		"</firecode_watcher>",
	].join("\n"));
});

test("用户 esc 中断过的现场照常投递，投递选项不变", async () => {
	const harness = await setup();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	faux.appendResponses([async () => {
		await gate;
		return fauxAssistantMessage([fauxToolCall("advise", { note: "迁移脚本会删表" })], { stopReason: "toolUse" });
	}, fauxAssistantMessage("已提交")]);
	const delivered = harness.next();
	await harness.turnEnd(9, "写迁移脚本");
	await harness.emit("agent_end", {
		type: "agent_end",
		messages: [{ role: "assistant", content: [], stopReason: "aborted" }],
	});
	release();
	await delivered;

	expect(harness.messages).toHaveLength(1);
	expect(harness.messages[0].options).toEqual(QUEUE_OPTIONS);
	expect(harness.messages[0].message.details).toEqual({ note: "迁移脚本会删表", turnIndex: 9 });
});

test("fire-review 活跃期零评估，结束后合并补上", async () => {
	const harness = await setup();
	advise("两个回合一起看到的");
	harness.pi.events.emit("herdr:blocked", { active: true });
	await harness.turnEnd(2, "审查中的改动");
	await harness.turnEnd(3, "又一个回合");
	await Bun.sleep(20);
	expect(faux.getPendingResponseCount()).toBe(2);
	expect(harness.messages).toEqual([]);

	const delivered = harness.next();
	harness.pi.events.emit("herdr:blocked", { active: false });
	await delivered;
	expect(faux.getPendingResponseCount()).toBe(0);
	expect(harness.notes()).toEqual([{ note: "两个回合一起看到的", turnIndex: 3 }]);
});

test("评估落后时合并跳最新，同批增量只产生一条建议", async () => {
	const harness = await setup();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let merged = "";
	faux.appendResponses([
		async () => {
			await gate;
			return fauxAssistantMessage([fauxToolCall("advise", { note: "第一次" })], { stopReason: "toolUse" });
		},
		fauxAssistantMessage("已提交"),
		(context: any) => {
			merged = latestUserText(context);
			return fauxAssistantMessage([fauxToolCall("advise", { note: "合并后的建议" })], { stopReason: "toolUse" });
		},
		fauxAssistantMessage("已提交"),
	]);
	const first = harness.next();
	await harness.turnEnd(1, "第一回合");
	await harness.turnEnd(2, "第二回合");
	await harness.turnEnd(3, "第三回合");
	release();
	await first;
	await harness.next();

	expect(faux.getPendingResponseCount()).toBe(0);
	// append-only：新一批只带落后的回合，已评估过的第 1 回合留在前缀里不重发。
	expect(merged).toContain('<turn index="2">');
	expect(merged).toContain('<turn index="3">');
	expect(merged).not.toContain('<turn index="1">');
	expect(harness.notes()).toEqual([
		{ note: "第一次", turnIndex: 1 },
		{ note: "合并后的建议", turnIndex: 3 },
	]);
});

test("主会话空闲时发言走前门用户消息，不出卡片", async () => {
	const harness = await setup();
	harness.idle = true;
	advise("空闲现场的提醒");
	const delivered = harness.next();
	await harness.turnEnd(9, "刚停下");
	await delivered;

	expect(harness.messages).toEqual([]);
	expect(harness.userMessages).toHaveLength(1);
	expect(harness.userMessages[0]).toContain("<firecode_watcher>");
	expect(harness.userMessages[0]).toContain("空闲现场的提醒");
});

test("一次评估只接受一条 advise，多余的当场拒绝", async () => {
	const harness = await setup();
	faux.appendResponses([
		fauxAssistantMessage([
			fauxToolCall("advise", { note: "第一条" }),
			fauxToolCall("advise", { note: "第二条" }),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage("已提交"),
	]);
	const delivered = harness.next();
	await harness.turnEnd(5, "一堆改动");
	await delivered;

	expect(harness.notes()).toEqual([{ note: "第一条", turnIndex: 5 }]);
});

test("裸 /fire-watch 来回翻转当前会话并拒绝旧参数", async () => {
	const harness = await setup();
	advise("重新开启后的建议");
	expect(harness.statuses.get("watcher")).toBe("👓 watcher/low");
	await harness.command("");
	expect(harness.statuses.has("watcher")).toBeFalse();
	await harness.turnEnd(1, "关闭期间的回合");
	await Bun.sleep(20);
	expect(faux.getPendingResponseCount()).toBe(2);
	expect(harness.messages).toEqual([]);

	const delivered = harness.next();
	await harness.command("");
	expect(harness.statuses.get("watcher")).toBe("👓 watcher/low");
	await harness.turnEnd(2, "重新开启后的回合");
	await delivered;
	expect(harness.notes()).toEqual([{ note: "重新开启后的建议", turnIndex: 2 }]);

	await harness.command("on");
	expect(harness.notices.at(-1)).toContain("不接受参数");
});

test("watcher 节缺失时拒绝启动并说明原因，不拿默认模型代替", async () => {
	const harness = await setup({ watcher: null });
	await harness.turnEnd(1, "回合");
	await Bun.sleep(20);
	expect(faux.getPendingResponseCount()).toBe(0);

	await harness.command("");
	expect(harness.notices.join("\n")).toContain("watcher.model 必须是“provider/model/thinking”字符串");
});

test("无建议时保持沉默；增量带上工具调用与工具结果，minimal 只省推理与正文", async () => {
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

	expect(harness.messages).toEqual([]);
	expect(increment).toContain("→ bash：3 files changed");
	expect(increment).toContain("✗ write：permission denied");
	expect(increment).toContain("command=git status");
	// minimal 只省推理与 diff 正文：写入动作还在，正文只留长度。
	expect(increment).toContain("content=<50 字符>");
	expect(increment).not.toContain("xxxxx");
});

test("features.watcher 写成非布尔值时拒绝启动，不静默启用", async () => {
	const harness = await setup({ features: { watcher: "false" } });
	advise("不应该被看到");
	await harness.turnEnd(1, "回合");
	await Bun.sleep(20);
	expect(faux.getPendingResponseCount()).toBe(2);
	expect(harness.messages).toEqual([]);

	await harness.command("");
	expect(harness.notices.join("\n")).toContain("features.watcher 必须是 true 或 false");
});

test("主会话压缩后从当前尾部重新入场，不回放旧增量", async () => {
	const harness = await setup();
	advise("压缩前");
	let reentry: any[] = [];
	faux.appendResponses([
		(context: any) => {
			reentry = context.messages.filter((message: any) => message.role === "user");
			return fauxAssistantMessage([fauxToolCall("advise", { note: "压缩后" })], { stopReason: "toolUse" });
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
	expect(harness.notes().at(-1)).toEqual({ note: "压缩后", turnIndex: 2 });
});

test("评估途中发生压缩时丢弃过期建议，观察员不被拖垮", async () => {
	let finishEvaluation!: (advice: any) => void;
	let evaluationStarted!: () => void;
	const started = new Promise<void>((resolve) => { evaluationStarted = resolve; });
	const observers = [
		{
			evaluate: () => {
				evaluationStarted();
				return new Promise<any>((resolve) => { finishEvaluation = resolve; });
			},
			contextPercent: () => 0,
			dispose() {},
		},
		{
			evaluate: async () => ({ note: "压缩后的建议" }),
			contextPercent: () => 0,
			dispose() {},
		},
	];
	const harness = await setup({ createObserver: async () => observers.shift() });
	await harness.turnEnd(1, "压缩前的回合");
	await started;
	await harness.emit("session_compact", { type: "session_compact" });
	finishEvaluation({ note: "压缩前的现场" });
	await Bun.sleep(0);
	expect(harness.messages).toEqual([]);
	expect(harness.notices).toEqual([]);

	const delivered = harness.next();
	await harness.turnEnd(2, "压缩后的回合");
	await delivered;
	expect(harness.notes()).toEqual([{ note: "压缩后的建议", turnIndex: 2 }]);
});

test("评估中切换会话后旧任务不访问旧 ctx，也不关闭新 runtime", async () => {
	let rejectEvaluation!: (error: Error) => void;
	let evaluationStarted!: () => void;
	const started = new Promise<void>((resolve) => { evaluationStarted = resolve; });
	const observers = [
		{
			evaluate: () => {
				evaluationStarted();
				return new Promise<undefined>((_resolve, reject) => { rejectEvaluation = reject; });
			},
			contextPercent: () => 0,
			dispose() {},
		},
		{
			evaluate: async () => ({ note: "新会话仍在工作" }),
			contextPercent: () => 0,
			dispose() {},
		},
	];
	const harness = await setup({ createObserver: async () => observers.shift() });
	await harness.turnEnd(1, "旧会话");
	await started;
	const oldContext = harness.context;
	const nextContext = harness.createContext();
	await harness.sessionStart(nextContext.ctx);
	oldContext.retire();
	rejectEvaluation(new Error("旧评估失败"));
	await Bun.sleep(0);

	expect(oldContext.staleAccesses).toEqual([]);
	const delivered = harness.next();
	await harness.turnEnd(2, "新会话", [], [], nextContext.ctx);
	await delivered;
	expect(harness.notes()).toEqual([{ note: "新会话仍在工作", turnIndex: 2 }]);
});

test("Observer 创建中切换会话时释放迟到资源且不执行旧评估", async () => {
	let releaseCreation!: (observer: any) => void;
	let creationStarted!: () => void;
	const started = new Promise<void>((resolve) => { creationStarted = resolve; });
	let lateEvaluations = 0;
	let lateDisposals = 0;
	const lateObserver = {
		evaluate: async () => { lateEvaluations += 1; return undefined; },
		contextPercent: () => 0,
		dispose: () => { lateDisposals += 1; },
	};
	let creation = 0;
	const harness = await setup({
		createObserver: async () => {
			creation += 1;
			if (creation === 1) {
				creationStarted();
				return new Promise<any>((resolve) => { releaseCreation = resolve; });
			}
			return {
				evaluate: async () => ({ note: "新 owner 的建议" }),
				contextPercent: () => 0,
				dispose() {},
			};
		},
	});
	await harness.turnEnd(1, "旧会话");
	await started;
	const oldContext = harness.context;
	const nextContext = harness.createContext();
	await harness.sessionStart(nextContext.ctx);
	oldContext.retire();
	releaseCreation(lateObserver);
	await Bun.sleep(0);

	expect(lateEvaluations).toBe(0);
	expect(lateDisposals).toBe(1);
	expect(oldContext.staleAccesses).toEqual([]);
	const delivered = harness.next();
	await harness.turnEnd(2, "新会话", [], [], nextContext.ctx);
	await delivered;
	expect(harness.notes()).toEqual([{ note: "新 owner 的建议", turnIndex: 2 }]);
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

function advise(note: string) {
	faux.appendResponses([
		fauxAssistantMessage([fauxToolCall("advise", { note })], { stopReason: "toolUse" }),
		fauxAssistantMessage("已提交"),
	]);
}

async function setup(options: {
	watcher?: Record<string, unknown> | null;
	worker?: boolean;
	features?: Record<string, unknown>;
	createObserver?: (...args: any[]) => Promise<any>;
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
	const messages: any[] = [];
	const userMessages: string[] = [];
	const notices: string[] = [];
	let idle = false;
	const statuses = new Map<string, string>();
	let waiter: (() => void) | undefined;
	const settle = () => waiter?.();
	const pi = {
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerMessageRenderer() {},
		on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		events: {
			on: (name: string, handler: any) => channels.set(name, [...(channels.get(name) ?? []), handler]),
			emit: (name: string, data: any) => { for (const handler of channels.get(name) ?? []) handler(data); },
		},
		sendMessage: (message: any, sendOptions: any) => { messages.push({ message, options: sendOptions }); settle(); },
		sendUserMessage: async (content: string) => { userMessages.push(content); settle(); },
	};
	const sessionId = crypto.randomUUID();
	const main = SessionManager.create(cwd, sessionDir);
	const createContext = () => {
		let retired = false;
		const staleAccesses: string[] = [];
		const raw = {
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
		const ctx = new Proxy(raw, {
			get(target, property, receiver) {
				if (retired) {
					staleAccesses.push(String(property));
					throw new Error(`stale ctx.${String(property)}`);
				}
				return Reflect.get(target, property, receiver);
			},
		});
		return { ctx, staleAccesses, retire: () => { retired = true; } };
	};
	const context = createContext();
	module.registerWatcher(pi, {
		pool,
		resolveModel: async () => fauxModel,
		...(options.createObserver ? { createObserver: options.createObserver } : {}),
	}, options.worker === true);
	const emit = async (name: string, event: any, ctx = context.ctx) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	await emit("session_start", { type: "session_start", reason: "startup" });
	return {
		messages,
		userMessages,
		notices,
		statuses,
		set idle(value: boolean) { idle = value; },
		notes: () => messages.map((entry) => entry.message.details),
		registeredCommands: [...commands.keys()],
		registeredEvents: [...handlers.keys()],
		pi,
		emit,
		context,
		createContext,
		sessionStart: (ctx: any) => emit("session_start", { type: "session_start", reason: "switch" }, ctx),
		next: () => new Promise<void>((resolve) => { waiter = () => { waiter = undefined; resolve(); }; }),
		command: (args: string) => commands.get("fire-watch").handler(args, context.ctx),
		turnEnd: (turnIndex: number, text: string, toolResults: any[] = [], toolCalls: any[] = [], ctx = context.ctx) =>
			emit("turn_end", {
				type: "turn_end",
				turnIndex,
				message: { role: "assistant", content: [{ type: "text", text }, ...toolCalls] },
				toolResults,
			}, ctx),
	};
}
