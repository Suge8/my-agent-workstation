import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader.ts";

const savedEnv = ["HERDR_ENV", "HERDR_WORKSPACE_ID", "FIRECODE_MASTER_WORKER"].map(
	(name) => [name, process.env[name]] as const,
);

afterEach(async () => {
	for (const [name, value] of savedEnv) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	await cleanupFirecodeModules();
});

test("master mode is opt-in and only appends subagents", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_WORKSPACE_ID = "w1";
	delete process.env.FIRECODE_MASTER_WORKER;
	const module = (await loadFirecodeModule("master/index.js")) as { registerMaster: (pi: unknown) => void };
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const tools = new Map<string, { promptGuidelines?: string[] }>();
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	let activeTools = ["read", "write", "edit", "bash"];
	const notices: string[] = [];
	const pi = {
		registerMessageRenderer() {},
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
		registerTool: (tool: { name: string; promptGuidelines?: string[] }) => tools.set(tool.name, tool),
		getActiveTools: () => [...activeTools],
		setActiveTools: (next: string[]) => { activeTools = next; },
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
			handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		events: { on() {}, emit() {} },
		appendEntry() {},
		sendMessage() {},
		sendUserMessage() {},
		exec: async () => ({ code: 0, stdout: "{}", stderr: "", killed: false }),
	};
	const ctx = makeCtx(notices);
	module.registerMaster(pi);
	expect([...tools.keys()]).toEqual(["subagents"]);
	expect(tools.get("subagents")?.promptGuidelines?.join()).toContain("custom follow-up message");
	expect(activeTools).toEqual(["read", "write", "edit", "bash"]);

	await commands.get("fire-master")?.handler("", ctx);
	expect(activeTools).toEqual(["read", "write", "edit", "bash", "subagents"]);
	for (const shutdown of handlers.get("session_shutdown") ?? []) await shutdown({ reason: "reload" }, ctx);
	expect(activeTools).toEqual(["read", "write", "edit", "bash"]);
});

test("list results render an inline pool snapshot on the tool line", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_WORKSPACE_ID = "w1";
	delete process.env.FIRECODE_MASTER_WORKER;
	const module = (await loadFirecodeModule("master/index.js")) as { registerMaster: (pi: unknown) => void };
	type Renderable = {
		renderCall: (args: Record<string, unknown>, theme: unknown, context: unknown) => { render(width: number): string[] };
		renderResult: (
			result: { content: Array<{ type: string; text: string }>; details?: unknown },
			options: { expanded: boolean },
			theme: unknown,
			context: unknown,
		) => unknown;
	};
	const tools = new Map<string, Renderable>();
	const pi = {
		registerMessageRenderer() {},
		registerCommand() {},
		registerTool: (tool: { name: string } & Renderable) => tools.set(tool.name, tool),
		getActiveTools: () => [],
		setActiveTools() {},
		on() {},
		events: { on() {}, emit() {} },
	};
	module.registerMaster(pi);
	const tool = tools.get("subagents");
	if (!tool) throw new Error("subagents 未注册");
	const theme = { fg: (_c: string, text: string) => text, bold: (text: string) => text };
	const makeContext = (isError = false) => ({
		state: {}, cwd: "/tmp", toolCallId: crypto.randomUUID(), isPartial: false, isError, expanded: false,
	});

	const empty = makeContext();
	tool.renderResult({ content: [{ type: "text", text: "{}" }], details: { workers: [] } }, { expanded: false }, theme, empty);
	expect(tool.renderCall({ action: "list" }, theme, empty).render(76)[0]).toContain("子代理 查看 — 空");

	const populated = makeContext();
	const workers = [
		{ name: "parser-sonnet", status: "working", model: "anthropic/claude", thinking: "medium" },
		{ name: "wiki-core", status: "dormant", model: "anthropic/claude", thinking: "medium" },
	];
	tool.renderResult({ content: [{ type: "text", text: "{}" }], details: { workers } }, { expanded: false }, theme, populated);
	expect(tool.renderCall({ action: "list" }, theme, populated).render(76)[0])
		.toContain("子代理 查看 — parser-sonnet 工作 · wiki-core 休眠");

	// 错误结果不回写快照：行尾保留给错误摘要。
	const failed = makeContext(true);
	tool.renderResult({ content: [{ type: "text", text: "boom" }], details: { workers } }, { expanded: false }, theme, failed);
	expect(tool.renderCall({ action: "list" }, theme, failed).render(76)[0]).not.toContain("—");
});

test("a failed recovery rolls activation back so the next attempt retries", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_WORKSPACE_ID = "w1";
	delete process.env.FIRECODE_MASTER_WORKER;
	const module = (await loadFirecodeModule("master/index.js", {
		replacements: { 'from "./herdr.js"': 'from "./herdr-stub.js"' },
		extraFiles: {
			"master/herdr-stub.ts": `
				export class HerdrWorkers {
					static resumeCalls = 0;
					async resume() {
						HerdrWorkers.resumeCalls += 1;
						if (HerdrWorkers.resumeCalls === 1) throw new Error("temporary Herdr failure");
					}
					shutdown() {}
					async cleanup() { return []; }
				}
			`,
		},
	})) as { registerMaster: (pi: unknown) => void };
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	let activeTools = ["read", "bash"];
	const notices: string[] = [];
	const pi = {
		registerMessageRenderer() {},
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
		registerTool() {},
		getActiveTools: () => [...activeTools],
		setActiveTools: (tools: string[]) => { activeTools = tools; },
		on() {},
		events: { on() {}, emit() {} },
		appendEntry() {},
		sendMessage() {},
		sendUserMessage() {},
		exec: async () => ({ code: 0, stdout: "{}", stderr: "", killed: false }),
	};
	const ctx = makeCtx(notices);
	module.registerMaster(pi);
	await commands.get("fire-master")?.handler("", ctx);
	expect(activeTools).toEqual(["read", "bash"]);
	await commands.get("fire-master")?.handler("", ctx);
	expect(notices[0]).toContain("temporary Herdr failure");
	expect(activeTools).toEqual(["read", "bash", "subagents"]);
});

test("Worker results return as follow-up custom messages", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_WORKSPACE_ID = "w1";
	delete process.env.FIRECODE_MASTER_WORKER;
	const module = (await loadFirecodeModule("master/index.js", {
		replacements: { 'from "./herdr.js"': 'from "./herdr-stub.js"' },
		extraFiles: {
			"master/herdr-stub.ts": `
				export class HerdrWorkers {
					constructor(options) { this.notify = options.notifyMaster; }
					async resume() {}
					async start(ctx, options) {
						this.notify("子代理 worker-1 已停下\\n回复：完成");
						return { name: "worker-1", model: options.model, thinking: options.thinking, status: "idle" };
					}
					shutdown() {}
					async cleanup() { return []; }
				}
			`,
		},
	})) as { registerMaster: (pi: unknown) => void };
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const messages: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
	let activeTools = ["read", "bash"];
	const pi = {
		registerMessageRenderer() {},
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.set(tool.name, tool),
		getActiveTools: () => [...activeTools],
		setActiveTools: (next: string[]) => { activeTools = next; },
		on() {},
		events: { on() {}, emit() {} },
		appendEntry() {},
		sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>) => messages.push({ message, options }),
		sendUserMessage() {},
		exec: async () => ({ code: 0, stdout: "{}", stderr: "", killed: false }),
	};
	const ctx = makeCtx([]);
	module.registerMaster(pi);
	await commands.get("fire-master")?.handler("", ctx);
	// 选型门禁：省略与表外 model 都在投递前拒绝——静默继承指挥官模型会拿最贵的一档真实发起子代理。
	await expect(tools.get("subagents")?.execute("call", { action: "start", prompt: "做" }, undefined, undefined, ctx))
		.rejects.toThrow("必须显式指定 model");
	await expect(tools.get("subagents")?.execute("call", { action: "start", prompt: "做", model: "vendor/not-in-roster" }, undefined, undefined, ctx))
		.rejects.toThrow("不在选型表");
	// thinking 同样必填：档位直接决定花销，继承指挥官的思考等级也是静默花钱。
	await expect(tools.get("subagents")?.execute("call", { action: "start", prompt: "做", model: "openai/gpt-4.1" }, undefined, undefined, ctx))
		.rejects.toThrow("必须显式指定 thinking");
	const started = await tools.get("subagents")?.execute("call", { action: "start", prompt: "做", model: "openai/gpt-4.1", thinking: "high" }, undefined, undefined, ctx) as { details: { worker: { model: string; thinking: string } } };
	expect(started.details.worker).toMatchObject({ model: "openai/gpt-4.1", thinking: "high" });
	await new Promise((resolve) => setTimeout(resolve, 120));
	expect(messages).toEqual([{
		message: {
			customType: "firecode-master-event",
			content: "子代理 worker-1 已停下\n回复：完成",
			display: true,
			// content 给模型，details 驱动紧凑卡：每事件一行标题。
			details: { version: 1, titles: ["子代理 worker-1 已停下"] },
		},
		options: { deliverAs: "followUp", triggerTurn: true },
	}]);
});

test("review action exposes reviewing in Master status without accepting prompt content", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_WORKSPACE_ID = "w1";
	delete process.env.FIRECODE_MASTER_WORKER;
	const module = (await loadFirecodeModule("master/index.js", {
		// 发行配置默认关闭模型能力；该接缝测试固定在 review/master 已启用时验证成功路径。
		configJsonc: '{"features":{"review":true,"master":true}}',
		replacements: { 'from "./herdr.js"': 'from "./herdr-stub.js"' },
		extraFiles: {
			"master/herdr-stub.ts": `
				export class HerdrWorkers {
					constructor(options) { this.store = options.store; }
					async resume() {}
					async start() {
						const worker = { name: "worker-1", paneId: "w1:p2", tabId: "w1:t2", sessionPath: "/tmp/worker.jsonl", model: "p/m", thinking: "medium", status: "idle" };
						this.store.dispatch({ type: "UPSERT_WORKER", worker });
						return worker;
					}
					async review(worker) {
						if (arguments.length !== 1) throw new Error("review received injected parameters");
						const current = this.store.state.workers.find((item) => item.name === worker);
						this.store.dispatch({ type: "UPSERT_WORKER", worker: { ...current, status: "reviewing" } });
					}
					shutdown() {}
					async cleanup() { return []; }
				}
			`,
		},
	})) as { registerMaster: (pi: unknown) => void };
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<Record<string, unknown>> }>();
	const notices: string[] = [];
	const statuses: Array<string | undefined> = [];
	let activeTools = ["read"];
	const pi = {
		registerMessageRenderer() {},
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<Record<string, unknown>> }) => tools.set(tool.name, tool),
		getActiveTools: () => [...activeTools],
		setActiveTools: (next: string[]) => { activeTools = next; },
		on() {},
		events: { on() {}, emit() {} },
		appendEntry() {},
		sendMessage() {},
		sendUserMessage() {},
		exec: async () => ({ code: 0, stdout: "{}", stderr: "", killed: false }),
	};
	const ctx = {
		...makeCtx(notices),
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus: (_key: string, value?: string) => statuses.push(value),
			theme: { fg: (_color: string, text: string) => text },
		},
	};
	module.registerMaster(pi);
	await commands.get("fire-master")?.handler("", ctx);
	await tools.get("subagents")?.execute("call", { action: "start", prompt: "做", model: "openai/gpt-4.1", thinking: "medium" }, undefined, undefined, ctx);
	const result = await tools.get("subagents")?.execute(
		"call",
		{ action: "review", worker: "worker-1", prompt: "malicious override" },
		undefined,
		undefined,
		ctx,
	);
	await commands.get("fire-master")?.handler("status", ctx);
	expect(result?.details).toEqual({ reviewing: true });
	expect(statuses.at(-1)).toContain("审1");
	expect(notices.at(-1)).toContain("worker-1 reviewing");
	await commands.get("fire-master")?.handler("off", ctx);
});

test("Worker keeps pi default tools minus the Master tool and cannot edit/write outside the checkout", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_WORKSPACE_ID = "w1";
	process.env.FIRECODE_MASTER_WORKER = "worker";
	const module = (await loadFirecodeModule("master/index.js")) as { registerMaster: (pi: unknown) => void };
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	let activeTools = ["read", "bash", "subagents"];
	const pi = {
		registerMessageRenderer() {},
		registerCommand() {},
		registerTool() {},
		getActiveTools: () => [...activeTools],
		setActiveTools: (next: string[]) => { activeTools = next; },
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
			handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		events: { on() {}, emit() {} },
		appendEntry() {},
		sendMessage() {},
		sendUserMessage() {},
		exec: async () => ({ code: 0, stdout: "{}", stderr: "", killed: false }),
	};
	const directory = await mkdtemp(join(tmpdir(), "firecode-worker-guard-"));
	const ctx = makeCtx([], directory);
	module.registerMaster(pi);
	for (const start of handlers.get("session_start") ?? []) await start({}, ctx);
	// ADR-0004：Worker 就是普通 pi（含 bash），只拿不到 Master 工具。
	expect(activeTools).toEqual(["read", "bash"]);
	const guard = handlers.get("tool_call")?.[0];
	expect(guard).toBeDefined();
	for (const path of [
		"package.json",
		"vcpkg.json",
		"node_modules/pkg/source.ts",
		"__pypackages__/lib/source.py",
	]) expect(await guard?.({ toolName: "edit", input: { path } }, ctx)).toBeUndefined();
	expect(await guard?.({ toolName: "write", input: { path: "../outside.ts" } }, ctx)).toEqual({
		block: true,
		reason: "子代理只能修改当前 checkout：../outside.ts",
	});
	expect(await guard?.({ toolName: "edit", input: { path: "src/index.ts" } }, ctx)).toBeUndefined();
	await rm(directory, { recursive: true, force: true });
});

test("review action is refused before delivery when fire-review is unavailable", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_WORKSPACE_ID = "w1";
	delete process.env.FIRECODE_MASTER_WORKER;
	const module = (await loadFirecodeModule("master/index.js", {
		configJsonc: '{"features":{"review":false}}',
		replacements: { 'from "./herdr.js"': 'from "./herdr-stub.js"' },
		extraFiles: {
			"master/herdr-stub.ts": `
				export class HerdrWorkers {
					constructor(options) { this.store = options.store; }
					async resume() {}
					async review() { throw new Error("review 不应被投递"); }
					shutdown() {}
					async cleanup() { return []; }
				}
			`,
		},
	})) as { registerMaster: (pi: unknown) => void };
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<Record<string, unknown>> }>();
	let activeTools = ["read"];
	const pi = {
		registerMessageRenderer() {},
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<Record<string, unknown>> }) => tools.set(tool.name, tool),
		getActiveTools: () => [...activeTools],
		setActiveTools: (next: string[]) => { activeTools = next; },
		on() {},
		events: { on() {}, emit() {} },
		appendEntry() {},
		sendMessage() {},
		sendUserMessage() {},
		exec: async () => ({ code: 0, stdout: "{}", stderr: "", killed: false }),
	};
	const ctx = makeCtx([]);
	module.registerMaster(pi);
	await commands.get("fire-master")?.handler("", ctx);
	await expect(
		tools.get("subagents")?.execute("call", { action: "review", worker: "w" }, undefined, undefined, ctx),
	).rejects.toThrow("fire-review 已关闭");
	// 审查票在派发时即验可用性：review 不可用时 review:true 的 start 必须在投递前拒绝。
	await expect(
		tools.get("subagents")?.execute("call", { action: "start", worker: "w", prompt: "按工单实现", review: true }, undefined, undefined, ctx),
	).rejects.toThrow("fire-review 已关闭");
});

test("worker events wait out a running Master turn and merge into one follow-up", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_WORKSPACE_ID = "w1";
	delete process.env.FIRECODE_MASTER_WORKER;
	const module = (await loadFirecodeModule("master/index.js", {
		replacements: { 'from "./herdr.js"': 'from "./herdr-stub.js"' },
		extraFiles: {
			"master/herdr-stub.ts": `
				export class HerdrWorkers {
					constructor(options) { globalThis.__fcNotify = options.notifyMaster; }
					async resume() {}
					shutdown() {}
					async cleanup() { return []; }
				}
			`,
		},
	})) as { registerMaster: (pi: unknown) => void };
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	const sent: string[] = [];
	let activeTools = ["read"];
	const pi = {
		registerMessageRenderer() {},
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
		registerTool() {},
		getActiveTools: () => [...activeTools],
		setActiveTools: (next: string[]) => { activeTools = next; },
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
			handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		events: { on() {}, emit() {} },
		appendEntry() {},
		sendMessage: (message: { content: string }) => { sent.push(message.content); },
		sendUserMessage() {},
		exec: async () => ({ code: 0, stdout: "{}", stderr: "", killed: false }),
	};
	// isIdle 恒为 true：宿主在 emit agent_settled 前就置 idle，合并门槛必须是显式回合位而非 isIdle。
	const ctx = { ...makeCtx([]), isIdle: () => true };
	module.registerMaster(pi);
	await commands.get("fire-master")?.handler("", ctx);
	const notify = (globalThis as { __fcNotify?: (content: string) => void }).__fcNotify;
	// 回合开始（agent_start）后到达的两条错峰结果都不投递，哪怕 isIdle 已经报 true。
	for (const handler of handlers.get("agent_start") ?? []) await handler({}, ctx);
	notify?.("结果 A");
	await new Promise((resolve) => setTimeout(resolve, 150));
	notify?.("结果 B");
	await new Promise((resolve) => setTimeout(resolve, 150));
	expect(sent).toEqual([]);
	// agent_settled 才是回合边界：之后合并成一条 follow-up。
	for (const handler of handlers.get("agent_settled") ?? []) await handler({}, ctx);
	await new Promise((resolve) => setTimeout(resolve, 150));
	expect(sent).toEqual(["结果 A\n\n结果 B"]);
	delete (globalThis as { __fcNotify?: unknown }).__fcNotify;
});

test("crash 后未 ack 的 Worker 结果在恢复时重投并补 ack", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_WORKSPACE_ID = "w1";
	delete process.env.FIRECODE_MASTER_WORKER;
	const module = (await loadFirecodeModule("master/index.js", {
		replacements: { 'from "./herdr.js"': 'from "./herdr-stub.js"' },
		extraFiles: {
			"master/herdr-stub.ts": `
				export class HerdrWorkers {
					async resume() {}
					shutdown() {}
					async cleanup() { return []; }
				}
			`,
		},
	})) as { registerMaster: (pi: unknown) => void };
	const { masterStatePath } = (await loadFirecodeModule("master/state.js")) as {
		masterStatePath: (id: string) => string;
	};
	const sessionId = crypto.randomUUID();
	const statePath = masterStatePath(sessionId);
	const { writeFileSync, rmSync } = await import("node:fs");
	writeFileSync(statePath, JSON.stringify({
		version: 5,
		workers: [{ name: "worker-1", model: "p/m", thinking: "medium", status: "dormant", sessionPath: "/tmp/w.jsonl" }],
	}));
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	const sent: string[] = [];
	const appended: Array<[string, unknown]> = [];
	let activeTools = ["read"];
	const pi = {
		registerMessageRenderer() {},
		registerCommand() {},
		registerTool() {},
		getActiveTools: () => [...activeTools],
		setActiveTools: (next: string[]) => { activeTools = next; },
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
			handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		events: { on() {}, emit() {} },
		appendEntry: (type: string, data: unknown) => appended.push([type, data]),
		sendMessage: (message: { content: string }) => sent.push(message.content),
		sendUserMessage() {},
		exec: async () => ({ code: 0, stdout: "{}", stderr: "", killed: false }),
	};
	const ctx = {
		...makeCtx([]),
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => [],
			// 会话里留着：e1 未 ack（crash 窗口丢失），e2 已 ack（正常投递过）。
			getEntries: () => [
				{ type: "custom", customType: "firecode-master-pending-event", data: { id: "e1", content: "Worker worker-1 已停下" } },
				{ type: "custom", customType: "firecode-master-pending-event", data: { id: "e2", content: "旧结果" } },
				{ type: "custom", customType: "firecode-master-event-ack", data: { ids: ["e2"] } },
			],
		},
	};
	module.registerMaster(pi);
	try {
		for (const start of handlers.get("session_start") ?? []) await start({}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(sent).toEqual(["Worker worker-1 已停下"]);
		// 重投不重写 pending（原 entry 还在），只补 ack。
		expect(appended).toEqual([["firecode-master-event-ack", { ids: ["e1"] }]]);
	} finally {
		rmSync(statePath, { force: true });
		for (const shutdown of handlers.get("session_shutdown") ?? []) await shutdown({ reason: "reload" }, ctx);
	}
});

test("未处置的落定消息提醒一次、再不处置升级通知；ack 发落后不再打扰，对运行中子代理 ack 报错", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_WORKSPACE_ID = "w1";
	delete process.env.FIRECODE_MASTER_WORKER;
	const module = (await loadFirecodeModule("master/index.js", {
		replacements: { 'from "./herdr.js"': 'from "./herdr-stub.js"' },
		extraFiles: {
			"master/herdr-stub.ts": `
				export class HerdrWorkers {
					constructor(options) {
						globalThis.__fcStore = options.store;
						globalThis.__fcNotify = options.notifyMaster;
					}
					async resume() {}
					shutdown() {}
					async cleanup() { return []; }
				}
			`,
		},
	})) as { registerMaster: (pi: unknown) => void };
	const { masterStatePath } = (await loadFirecodeModule("master/state.js")) as {
		masterStatePath: (id: string) => string;
	};
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	const sent: string[] = [];
	const notices: string[] = [];
	let activeTools = ["read"];
	const pi = {
		registerMessageRenderer() {},
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.set(tool.name, tool),
		getActiveTools: () => [...activeTools],
		setActiveTools: (next: string[]) => { activeTools = next; },
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
			handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		events: { on() {}, emit() {} },
		appendEntry() {},
		sendMessage: (message: { content: string }) => sent.push(message.content),
		sendUserMessage() {},
		exec: async () => ({ code: 0, stdout: "{}", stderr: "", killed: false }),
	};
	const sessionId = crypto.randomUUID();
	const ctx = {
		...makeCtx(notices),
		sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
	};
	const settle = async () => {
		for (const handler of handlers.get("agent_settled") ?? []) await handler({}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 150));
	};
	const { rmSync } = await import("node:fs");
	module.registerMaster(pi);
	try {
		await commands.get("fire-master")?.handler("", ctx);
		const store = (globalThis as { __fcStore?: { dispatch: (event: unknown) => void; state: { workers: Array<Record<string, unknown>> } } }).__fcStore;
		const notify = (globalThis as { __fcNotify?: (content: string, worker?: string) => void }).__fcNotify;
		store?.dispatch({ type: "UPSERT_WORKER", worker: {
			name: "worker-1", paneId: "w1:p2", tabId: "w1:t2", sessionPath: "/tmp/w.jsonl",
			model: "p/m", thinking: "medium", status: "idle",
		} });
		// 落定消息送达即置 pending。
		notify?.("子代理 worker-1 已停下", "worker-1");
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(sent).toHaveLength(1);
		expect(store?.state.workers[0]?.disposition).toBe("pending");
		// 回合结束未处置 → 提醒一次，送达后推进到 reminded。
		await settle();
		expect(sent).toHaveLength(2);
		expect(sent[1]).toContain("提醒：子代理 worker-1");
		expect(store?.state.workers[0]?.disposition).toBe("reminded");
		// 提醒回合仍不处置 → 升级用户通知并收口，不再追加。
		await settle();
		expect(sent).toHaveLength(2);
		expect(notices.join()).toContain("仍未发落");
		expect(store?.state.workers[0]?.disposition).toBeUndefined();
		// ack 是合法发落：清标记，后续回合零打扰。
		notify?.("子代理 worker-1 已停下", "worker-1");
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(store?.state.workers[0]?.disposition).toBe("pending");
		await tools.get("subagents")?.execute("call", { action: "ack", worker: "worker-1" }, undefined, undefined, ctx);
		expect(store?.state.workers[0]?.disposition).toBeUndefined();
		const before = sent.length;
		await settle();
		expect(sent).toHaveLength(before);
		// 护栏：对无待发落标记的运行中子代理 ack 报错指向 interrupt/sleep，不返回假成功（ADR-0007）。
		store?.dispatch({ type: "UPSERT_WORKER", worker: {
			name: "worker-2", paneId: "w1:p3", tabId: "w1:t2", sessionPath: "/tmp/w2.jsonl",
			model: "p/m", thinking: "medium", status: "working",
		} });
		await expect(tools.get("subagents")?.execute("call", { action: "ack", worker: "worker-2" }, undefined, undefined, ctx))
			.rejects.toThrow(/只把消息标为已处理.*interrupt/);
		// blocked 的出路是 send 回答，报错不得指向 interrupt/sleep。
		store?.dispatch({ type: "UPSERT_WORKER", worker: {
			name: "worker-3", paneId: "w1:p4", tabId: "w1:t2", sessionPath: "/tmp/w3.jsonl",
			model: "p/m", thinking: "medium", status: "blocked",
		} });
		await expect(tools.get("subagents")?.execute("call", { action: "ack", worker: "worker-3" }, undefined, undefined, ctx))
			.rejects.toThrow(/用 send 回答/);
	} finally {
		rmSync(masterStatePath(sessionId), { force: true });
		for (const shutdown of handlers.get("session_shutdown") ?? []) await shutdown({ reason: "reload" }, ctx);
		delete (globalThis as { __fcStore?: unknown }).__fcStore;
		delete (globalThis as { __fcNotify?: unknown }).__fcNotify;
	}
});

test("subagents 工具行：中文动词 + 目标 + 关键参数，session 恢复只显文件名", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_WORKSPACE_ID = "w1";
	delete process.env.FIRECODE_MASTER_WORKER;
	const module = (await loadFirecodeModule("master/index.js", {
		replacements: { 'from "./herdr.js"': 'from "./herdr-stub.js"' },
		extraFiles: {
			"master/herdr-stub.ts": "export class HerdrWorkers { async resume() {} shutdown() {} async cleanup() { return []; } }",
		},
	})) as { registerMaster: (pi: unknown) => void };
	type Rendered = { render(width: number): string[] };
	type ToolDef = {
		label: string;
		renderCall: (args: Record<string, unknown>, theme: unknown, ctx: unknown) => Rendered;
	};
	const registered = new Map<string, ToolDef>();
	const pi = {
		registerMessageRenderer() {},
		registerCommand() {},
		registerTool: (tool: ToolDef & { name: string }) => registered.set(tool.name, tool),
		getActiveTools: () => ["read"],
		setActiveTools() {},
		on() {},
		events: { on() {}, emit() {} },
		appendEntry() {},
		sendMessage() {},
		sendUserMessage() {},
		exec: async () => ({ code: 0, stdout: "{}", stderr: "", killed: false }),
	};
	module.registerMaster(pi);
	const tool = registered.get("subagents");
	expect(tool?.label).toBe("子代理");
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const ctx = () => ({ state: {}, cwd: "/tmp", toolCallId: crypto.randomUUID(), isPartial: false, isError: false, expanded: false });
	const line = (args: Record<string, unknown>) => tool?.renderCall(args, theme, ctx()).render(90)[0] ?? "";
	const start = line({ action: "start", worker: "t2", model: "anthropic/gpt-4.1-mini", review: true, prompt: "只回复 1\n第二行不进工具行" });
	expect(start).toContain("子代理 启动 t2 · gpt-4.1-mini · 审查票 — 只回复 1");
	expect(start).not.toContain("第二行");
	expect(line({ action: "send", worker: "t1", prompt: "继续" })).toContain("发送 t1 — 继续");
	expect(line({ action: "interrupt", worker: "t1" })).toContain("中断 t1");
	expect(line({ action: "ack", worker: "t1" })).toContain("待命 t1");
	expect(line({ action: "sleep", worker: "t1" })).toContain("休眠 t1");
	expect(line({ action: "kill", worker: "t2" })).toContain("移除 t2");
	expect(line({ action: "list" })).toContain("查看");
	// 历史会话里的退役动作名仍能渲染（ADR-0007）。
	expect(line({ action: "hold", worker: "t1" })).toContain("待命 t1");
	expect(line({ action: "stop", worker: "t2", forget: true })).toContain("移除 t2");
	// session 恢复：整条绝对路径只显文件名，行尾截断不吃真信息。
	expect(line({ action: "start", session: "/tmp/sessions/2026-08-16T01_abc.jsonl", prompt: "继续" }))
		.toContain("启动 2026-08-16T01_abc.jsonl");
});

test("自渲染工具必须在分流白名单内，否则兜底行会遮掉其 renderCall", async () => {
	const { FIRECODE_TOOLS } = (await loadFirecodeModule("tools/grouping.js")) as { FIRECODE_TOOLS: Set<string> };
	// 曾踩过的坑：subagents 挂了 renderCall 却不在白名单，中文工具行从未被调用。
	for (const name of ["read", "bash", "edit", "write", "subagents"]) expect(FIRECODE_TOOLS.has(name)).toBe(true);
});

function makeCtx(notices: string[], cwd = "/tmp") {
	return {
		cwd,
		isIdle: () => true,
		hasPendingMessages: () => false,
		model: { provider: "openai-codex", id: "gpt-4.1" },
		thinkingLevel: "medium",
		sessionManager: { getSessionId: () => crypto.randomUUID(), getBranch: () => [] },
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus() {},
			theme: { fg: (_color: string, text: string) => text },
		},
	};
}
