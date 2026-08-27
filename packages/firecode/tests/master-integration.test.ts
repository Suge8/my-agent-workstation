import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	cleanupFirecodeModules,
	loadFirecodeModule,
	PI_AI_COMPAT_URL,
	PI_CODING_AGENT_URL,
	TEST_REVIEW_CONFIG,
} from "./loader.ts";

const { fauxAssistantMessage, fauxToolCall, registerFauxProvider } = await import(PI_AI_COMPAT_URL) as any;
const TEST_ROLES = {
	工程师: { model: "test/worker/medium", use: "测试" },
	架构师: { model: "test/worker-2/high", use: "切换测试" },
};
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

test("新会话默认激活 subagents", async () => {
	const harness = await setup(false);
	await harness.emit("session_start", {});
	expect((await harness.list().then((result) => result.details as any)).workers).toEqual([]);
});

test("autoActivate false 的新会话不注入，仍可手动启动", async () => {
	const harness = await setup(false, { autoActivate: false });
	await harness.emit("session_start", {});
	await expect(harness.list()).rejects.toThrow("只在 Master 中可用");
	await harness.command("");
	expect((await harness.list().then((result) => result.details as any)).workers).toEqual([]);
});

test("status 每个子代理一行以角色为主、模型短名次之", async () => {
	const { statusText } = await loadFirecodeModule("master/index.js") as any;

	expect(statusText([
		{ name: "侦察", role: "调研员", status: "working", model: "openai-codex/gpt-5.1-codex-mini" },
		{ name: "验收", role: "工程师", status: "reviewing", model: "anthropic/claude-sonnet-4-5" },
	])).toBe("侦察 调研员·工作 gpt-5.1-codex-mini\n验收 工程师·审查 claude-sonnet-4-5");
});

test("裸 /fire-master 来回翻转当前会话，status 保留并拒绝旧参数", async () => {
	const harness = await setup(false);
	await harness.emit("session_start", {});
	await harness.command("");
	await expect(harness.list()).rejects.toThrow("只在 Master 中可用");
	await harness.command("status");
	expect(harness.notices.at(-1)).toBe("指挥官模式未启动");
	await harness.command("");
	expect((await harness.list().then((result) => result.details as any)).workers).toEqual([]);
	await harness.command("off");
	expect(harness.notices.at(-1)).toContain("只接受 status");
});

test("Master Markdown 与动态角色表按单一接缝注入", async () => {
	const harness = await setup();
	const prompt = await loadFirecodeModule("master/prompt.js") as any;
	const expected = prompt.assembleMasterPrompt(
		prompt.readMasterPrompt("master"),
		"工程师：test/worker/medium（测试）；架构师：test/worker-2/high（切换测试）",
	);
	expect(expected).toContain("角色表：工程师：test/worker/medium（测试）");
	expect(expected).toContain("投递：Worker 结果、中断与审查终态会自动送达；tail 仅用于按需读取执行细节。");
	expect(expected).toContain("何时审查：复杂且影响大的实现，以及无法靠窄测可靠验收的任务，需要对抗性审查，在 start 时传 review:true；其余任务省略。");
	expect(expected).toContain("如何启动：review:true 只是在任务开始时标记“这个任务完成后需要审查”，不会自动启动审查。这个标记不会因 send、reload、中断或失败而丢失，审查结束前不能 ack。Worker 返回结果并完成验证后，指挥官主动执行 review，才会开始对抗性审查。任务开始时没有标记 review:true，也可以在 Worker 空闲后主动执行 review；如果整个任务已经放弃，直接 kill。");
	expect(expected).toContain("审查过程：review 会在原 Worker 会话中启动。独立模型读取 Worker 的工作记录，核对相关文件和验证结果。发现问题时，审查意见会交回同一个 Worker 核实和修复，然后再次审查；审查通过、顾问决定停止或达到最大轮数后结束。审查通过时仍可能附带不阻塞交付的建议，由指挥官判断是否需要继续处理。");
	expect(await harness.systemPrompt("自定义系统提示")).toBe(`自定义系统提示\n\n${expected}`);
	await harness.command("");
	expect(await harness.systemPrompt("自定义系统提示")).toBe("自定义系统提示");
});

test("Worker Markdown 只组装动态名字与协议信封", async () => {
	const harness = await setup();
	const prompt = await loadFirecodeModule("master/prompt.js") as any;
	let systemPrompt = "";
	faux.setResponses([(context: any) => {
		systemPrompt = context.systemPrompt ?? "";
		return fauxAssistantMessage("完成");
	}]);
	const settled = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "start", worker: "prompt-contract", prompt: "执行", role: "工程师",
	});
	await settled;
	expect(systemPrompt).toContain(prompt.assembleWorkerPrompt(
		"你是指挥官委派的 Worker，只在当前 checkout 内完成工作说明。验证改动并报告结果、证据与遗留风险；无法完成或验证时如实报告阻塞原因和现场，不得假成功。Git 操作限于本地且仅覆盖自己修改的路径。",
		"prompt-contract",
	));
});

test("Master prompt 缺失或为空时只关闭 Master 并明确失败", async () => {
	const missing = await loadFirecodeModule("master/prompt.js") as any;
	expect(() => missing.readMasterPrompt("missing")).toThrow("Master missing prompt 读取失败");

	for (const kind of ["master", "worker"]) {
		const empty = await loadFirecodeModule("master/prompt.js", {
			extraFiles: { [`master/prompts/${kind}.zh.md`]: " \n" },
		}) as any;
		expect(() => empty.readMasterPrompt(kind)).toThrow(`Master ${kind} prompt 为空`);
	}

	const harness = await setup(true, {
		promptFiles: { "master/prompts/master.zh.md": " \n" },
	});
	expect(harness.notices.at(-1)).toContain("Master master prompt 为空");
	await expect(harness.list()).rejects.toThrow("只在 Master 中可用");
});

test("真 SDK 在执行前拒绝缺 worker 与旧 list 动作", async () => {
	const harness = await setup();
	const { createAgentSession, SessionManager } = await import(PI_CODING_AGENT_URL) as any;
	let executions = 0;
	const commandTool = {
		...harness.commandTool,
		execute: async (...args: any[]) => {
			executions += 1;
			return harness.commandTool.execute(...args);
		},
	};
	const { session } = await createAgentSession({
		cwd: harness.cwd,
		agentDir: harness.agentDir,
		model: harness.model,
		modelRuntime: harness.modelRuntime,
		tools: ["subagents"],
		customTools: [commandTool],
		sessionManager: SessionManager.inMemory(harness.cwd),
	});
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("subagents", {
			action: "start", prompt: "执行", role: "工程师",
		}), { stopReason: "toolUse" }),
		fauxAssistantMessage("已拒绝"),
	]);
	await session.prompt("调用 start，但不要传 worker");
	let result = session.messages.find((message: any) => message.role === "toolResult");
	expect(result?.isError).toBe(true);
	expect(JSON.stringify(result?.content)).toContain("worker");
	expect(executions).toBe(0);

	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("subagents", { action: "list", worker: "pool" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("已拒绝"),
	]);
	await session.prompt("调用旧 list 动作");
	result = session.messages.findLast((message: any) => message.role === "toolResult");
	expect(result?.isError).toBe(true);
	expect(JSON.stringify(result?.content)).toContain("action");
	expect(executions).toBe(0);
	session.dispose();
});

test("角色表、原子与 fallback 配置错误时拒绝启动", async () => {
	const harness = await setup(true, {
		roles: {
			工程师: {
				model: "invalid/high",
				thinking: "medium",
				use: "旧写法",
				fallback: ["test/a/low", "test/b/low", "test/c/low"],
			} as any,
		},
	});
	expect(harness.notices.join("\n")).toContain("Master 配置有问题，已停止");
	expect(harness.notices.join("\n")).toContain("未知字段 master.roles.工程师.thinking");
	expect(harness.notices.join("\n")).toContain("master.roles.工程师.model 模型无效");
	expect(harness.notices.join("\n")).toContain("master.roles.工程师.fallback 必须是至多 2 项的数组");
	await expect(harness.list()).rejects.toThrow("只在 Master 中可用");
});

test("角色表提示词只注入已配置角色，缺失角色拒绝派发并列出已配置项", async () => {
	const harness = await setup(true, { roles: { 工程师: TEST_ROLES.工程师 } });
	const prompt = await harness.systemPrompt("主提示词");
	expect(prompt).toContain("角色表：工程师：test/worker/medium（测试）");
	expect(prompt).not.toContain("架构师：");
	await expect(harness.execute({
		action: "start", worker: "missing-role", prompt: "执行",
	})).rejects.toThrow("start 必须指定 role");
	await expect(harness.execute({
		action: "start", worker: "outside-roster", prompt: "执行", role: "架构师",
	})).rejects.toThrow("角色未配置：架构师。已配置角色：工程师");

	faux.setResponses([fauxAssistantMessage("完成")]);
	const settled = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "start", worker: "switch-role", prompt: "执行", role: "工程师" });
	await settled;
	await expect(harness.execute({
		action: "send", worker: "switch-role", prompt: "继续", role: "架构师",
	})).rejects.toThrow("角色未配置：架构师。已配置角色：工程师");
});

test("subagents 是 worker 必填的七命令，池快照是独立零参查询", async () => {
	const harness = await setup();
	expect(harness.toolDescription).toContain("七动作");
	expect(harness.toolDescription).toContain("无 sleep/session");
	expect(harness.commandTool.parameters.type).toBe("object");
	expect(harness.commandTool.parameters.required).toEqual(["action", "worker"]);
	expect(harness.commandTool.parameters.properties.action.anyOf?.map((item: any) => item.const)
		?? harness.commandTool.parameters.properties.action.enum).not.toContain("list");
	expect(harness.parameterDescriptions.worker).toBe("start 起简短任务名；其余动作填目标 Worker。");
	expect(harness.parameterDescriptions.worker).not.toContain("必填");
	for (const name of ["action", "worker", "prompt", "role", "thinking", "cwd", "review"])
		expect(harness.parameterDescriptions[name]).not.toBeEmpty();
	expect(harness.commandTool.parameters.properties).not.toHaveProperty("model");
	expect(harness.parameterDescriptions.role).toContain("start 必填");
	expect(harness.parameterDescriptions.role).toContain("send");
	expect(harness.parameterDescriptions.role).toContain("切换");
	expect(harness.commandTool.parameters.properties.role.anyOf?.map((item: any) => item.const)
		?? harness.commandTool.parameters.properties.role.enum).toEqual([
		"调研员", "工程师", "全栈", "架构师", "设计师", "哨兵",
	]);
	expect(harness.parameterDescriptions.review).toContain("审查纪律");
	expect(harness.parameterDescriptions.review).toContain("true 不自动开审");
	expect(harness.listTool.description).toBe("查看子代理池快照");
	expect(harness.listTool.parameters.required ?? []).toEqual([]);
	expect(Object.keys(harness.listTool.parameters.properties)).toEqual([]);
	expect((await harness.list().then((result) => result.details as any)).workers).toEqual([]);
});

test("list 展开投影 working 的当前工具，但模型正文不含动作", async () => {
	const harness = await setup();
	let releaseResponse!: () => void;
	const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
	let releaseTool!: () => void;
	const toolGate = new Promise<void>((resolve) => { releaseTool = resolve; });
	faux.setResponses([
		async () => {
			await responseGate;
			return fauxAssistantMessage(fauxToolCall("read", { path: "AGENTS.md" }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("完成"),
	]);
	const started = await harness.execute({
		action: "start", worker: "observed", prompt: "读取约束", role: "工程师",
	});
	const session = harness.pool.getSession((started.details as any).worker.session);
	const toolStarted = new Promise<void>((resolve) => session.subscribe(async (event: any) => {
		if (event.type !== "tool_execution_start") return;
		resolve();
		await toolGate;
	}));
	const toolEventBefore = Date.now();
	releaseResponse();
	await toolStarted;
	const toolEventAfter = Date.now();

	const listed = await harness.list();
	expect(JSON.parse(listed.content[0].text)).toEqual({ workers: [expect.objectContaining({ name: "observed", status: "working" })] });
	expect(listed.content[0].text).not.toContain("currentAction");
	const workingAction = (listed.details as any).workers[0].currentAction;
	expect(workingAction).toMatchObject({ kind: "tool", tool: "read" });
	expect(typeof workingAction.startedAt).toBe("number");
	expect(workingAction.startedAt >= toolEventBefore).toBe(true);
	expect(workingAction.startedAt <= toolEventAfter).toBe(true);
	const collapsed = harness.renderListLine(listed);
	expect(collapsed).toHaveLength(1);
	expect(collapsed[0]).toContain("池 1：observed 工程师·工作");
	(listed.details as any).workers[0].currentAction.startedAt = Date.now() - 300;
	const expanded = harness.renderResult(listed, true).join("\n");
	expect(expanded).toContain("observed");
	expect(expanded).toMatch(/工程师·工作 · read · 已 0\.[34]s/u);

	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const settledBefore = Date.now();
	releaseTool();
	await delivered;
	const settledAfter = Date.now();
	const idle = await harness.list();
	const idleAction = (idle.details as any).workers[0].currentAction;
	expect(idleAction).toMatchObject({ kind: "idle" });
	expect(typeof idleAction.since).toBe("number");
	expect(idleAction.since >= settledBefore).toBe(true);
	expect(idleAction.since <= settledAfter).toBe(true);
	expect((idle.details as any).workers[0].currentAction).not.toHaveProperty("tool");
	(idle.details as any).workers[0].currentAction.since = Date.now() - 65_000;
	const idleLine = harness.renderResult(idle, true).join("\n");
	expect(idleLine).toContain("落定 1m5s前");
});

test("主回合忙碌时，subagents 以队列语义完成 start→事件落定→list→kill", async () => {
	const harness = await setup();
	await harness.emit("agent_start", {});
	faux.setResponses([fauxAssistantMessage("确定性完成")]);
	const settled = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });

	const started = await harness.execute({
		action: "start",
		worker: "trace",
		prompt: "只回复完成",
		role: "工程师",
		thinking: "low",
	});
	const worker = (started.details as any).worker;
	expect(worker).toMatchObject({ status: "working", role: "工程师", model: "test/worker", thinking: "low" });
	await settled;
	await Bun.sleep(0);

	const listed = await harness.list();
	expect(JSON.parse(listed.content[0].text).workers).toEqual([{ ...worker, status: "idle", disposition: "pending" }]);
	expect((listed.details as any).workers).toEqual([
		{ ...worker, status: "idle", disposition: "pending", currentAction: expect.objectContaining({ kind: "idle" }) },
	]);
	expect(harness.messages[0]).toMatchObject({
		message: { content: "<firecode_master_event>\n子代理 trace 已停下\n回复：\n确定性完成\n</firecode_master_event>" },
		options: { deliverAs: "steer" },
	});
	const trace = await harness.execute({ action: "tail", worker: "trace" });
	expect(trace.content[0].text).toContain("assistant: 确定性完成");
	const sessionPath = worker.session as string;
	expect(existsSync(sessionPath)).toBe(true);
	expect(dirname(sessionPath).endsWith("/subagents")).toBe(true);
	const { SessionManager } = await import(PI_CODING_AGENT_URL) as any;
	const visible = await SessionManager.list(harness.cwd, dirname(dirname(sessionPath)));
	expect(visible.some((session: any) => session.path === sessionPath)).toBe(false);

	await harness.execute({ action: "kill", worker: "trace" });
	expect((await harness.list().then((result) => result.details as any)).workers).toEqual([]);
	expect(existsSync(sessionPath)).toBe(true);
});

test("供应商故障在无 fallback 时明确报告链已用尽", async () => {
	const harness = await setup();
	faux.setResponses([async () => { throw new Error("quota exhausted"); }]);
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "start", worker: "failed", prompt: "执行", role: "工程师",
	});
	await delivered;
	expect(harness.messages[0].message.content).toBe("<firecode_master_event>\n子代理 failed 已停下\n错误：\nquota exhausted\n角色 工程师 的 fallback 链已用尽\n</firecode_master_event>");
	expect(harness.messages[0].message.details.titles).toEqual(["子代理 failed 已停下 — quota exhausted"]);
});

test("429 瞬时限流终态不触发 fallback，按原模型正常报错落定", async () => {
	const harness = await setup(true, {
		roles: {
			...TEST_ROLES,
			工程师: { ...TEST_ROLES.工程师, fallback: ["test/worker-2/high"] },
		},
	});
	faux.setResponses([fauxAssistantMessage("已启动")]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const started = await harness.execute({
		action: "start", worker: "rate-limited", prompt: "初始化", role: "工程师",
	});
	await delivered;

	const session = harness.pool.getSession((started.details as any).worker.session);
	session.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
	const rateLimit = fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit exceeded" });
	faux.setResponses([rateLimit, rateLimit]);
	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "send", worker: "rate-limited", prompt: "继续" });
	await delivered;

	const content = harness.messages.at(-1).message.content;
	expect(content).toContain("错误：\n429 rate limit exceeded");
	expect(content).not.toContain("已切换");
	const worker = (await harness.list().then((result) => result.details as any)).workers[0];
	expect(worker).toMatchObject({
		status: "idle", role: "工程师", model: "test/worker", thinking: "medium",
	});
});

test("供应商故障按角色 fallback 在同一会话续跑并更新实际模型", async () => {
	const harness = await setup(true, {
		roles: {
			...TEST_ROLES,
			工程师: { ...TEST_ROLES.工程师, fallback: ["test/worker-2/high"] },
		},
	});
	faux.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota" }),
		fauxAssistantMessage("降级后完成"),
	]);
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const started = await harness.execute({
		action: "start", worker: "fallback", prompt: "执行", role: "工程师",
	});
	await delivered;

	expect(harness.messages[0].message.content).toContain("已切换 test/worker/medium→test/worker-2/high（额度或计费耗尽）");
	expect(harness.messages[0].message.content).toContain("同一会话自动续跑");
	expect(harness.messages[0].message.content).toContain("回复：\n降级后完成");
	const worker = (await harness.list().then((result) => result.details as any)).workers[0];
	expect(worker).toMatchObject({
		role: "工程师", model: "test/worker-2", thinking: "high", session: (started.details as any).worker.session,
	});
});

test("溢出恢复删除运行时消息后仍落定供应商错误而非过期回复", async () => {
	const harness = await setup();
	faux.setResponses([fauxAssistantMessage("上一回合回复")]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const started = await harness.execute({
		action: "start", worker: "overflow", prompt: "初始化", role: "工程师",
	});
	await delivered;

	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const providerError = "maximum context length is 128 tokens";
	faux.setResponses([async () => {
		await gate;
		return fauxAssistantMessage("", { stopReason: "error", errorMessage: providerError });
	}]);
	const session = harness.pool.getSession((started.details as any).worker.session);
	const deleted = new Promise<void>((resolve) => session.subscribe((event: any) => {
		if (event.type !== "agent_end") return;
		session.messages.splice(-1, 1);
		resolve();
	}));
	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "send", worker: "overflow", prompt: "继续" });
	release();
	await deleted;
	await delivered;

	const content = harness.messages.at(-1).message.content;
	expect(content).toContain(`错误：\n${providerError}`);
	expect(content).not.toContain("上一回合回复");
	expect(content).not.toContain("（无回复）");
});

test("非显式中断的 aborted 终态落定明确原因", async () => {
	const harness = await setup();
	faux.setResponses([
		fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "upstream connection closed" }),
	]);
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "start", worker: "aborted", prompt: "执行", role: "工程师",
	});
	await delivered;

	expect(harness.messages[0].message.content).toContain("错误：\n回合意外中止：upstream connection closed");
	expect(harness.messages[0].message.content).not.toContain("（无回复）");
});

test("进程内池拒绝同一 sessionPath 的第二个持有者，恢复缺失文件明确失败", async () => {
	const harness = await setup();
	const module = await loadFirecodeModule("master/spawn.js") as any;
	const sessionPath = join(directory!, "sessions", "subagents", "worker.jsonl");
	await mkdir(dirname(sessionPath), { recursive: true });
	const options = {
		cwd: harness.cwd,
		model: faux.getModel(),
		thinking: "medium",
		tools: [],
		systemPrompt: { mode: "replace", text: "test" },
		contextFiles: false,
		persistence: { type: "file", sessionPath },
	};
	const pool = new module.InProcessSessionPool();
	const first = await pool.spawn(options);
	await expect(pool.spawn(options)).rejects.toThrow("已有进程内会话持有");
	first.dispose();
	await expect(pool.spawn({ ...options, persistence: { ...options.persistence, resume: true } }))
		.rejects.toThrow("会话文件不存在");
	pool.disposeAll();
});

test("空闲会话自动释放后 kill 仍只删档案并保留会话文件", async () => {
	const harness = await setup(true, { idleTimeoutMs: 10 });
	faux.setResponses([fauxAssistantMessage("完成")]);
	const settled = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const started = await harness.execute({
		action: "start", worker: "cold-kill", prompt: "完成", role: "工程师",
	});
	await settled;
	const sessionPath = (started.details as any).worker.session;
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(harness.pool.has(sessionPath)).toBe(false);
	await harness.execute({ action: "kill", worker: "cold-kill" });
	expect(existsSync(sessionPath)).toBe(true);
});

test("空闲前门投递未完成时替换会话，旧投递不得确认到新 runtime", async () => {
	const harness = await setup(true, { deferUserMessage: true });
	harness.idle = true;
	faux.setResponses([fauxAssistantMessage("旧会话结果")]);
	await harness.execute({
		action: "start", worker: "old-delivery", prompt: "执行", role: "工程师",
	});
	await harness.userMessageStarted;
	const appendedBeforeReplacement = harness.appended.length;

	await harness.replaceSession();
	harness.releaseUserMessage();
	await Bun.sleep(0);

	expect(harness.appended).toHaveLength(appendedBeforeReplacement);
	expect(harness.appended.map(([type]) => type)).toEqual(["firecode-master-pending-event"]);
	expect((await harness.list().then((result) => result.details as any)).workers).toEqual([]);
});

test("审查结算中替换会话，旧 continuation 不得写入新 runtime", async () => {
	const harness = await setup(true, { review: true, mockReview: true });
	faux.setResponses([fauxAssistantMessage("实现完成")]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const started = await harness.execute({
		action: "start", worker: "old-review", prompt: "实现", role: "工程师", review: true,
	});
	await delivered;

	const session = harness.pool.getSession((started.details as any).worker.session);
	let releaseReview!: () => void;
	const reviewGate = new Promise<void>((resolve) => { releaseReview = resolve; });
	const prompt = session.prompt.bind(session);
	session.prompt = (text: string) => text === "/fire-review" ? reviewGate : prompt(text);
	await harness.execute({ action: "review", worker: "old-review" });
	await harness.replaceSession();
	const appendedBeforeSettlement = harness.appended.length;
	const noticesBeforeSettlement = harness.notices.length;

	releaseReview();
	await Bun.sleep(0);

	expect(harness.appended).toHaveLength(appendedBeforeSettlement);
	expect(harness.notices).toHaveLength(noticesBeforeSettlement);
	expect((await harness.list().then((result) => result.details as any)).workers).toEqual([]);
});

test("主回合空闲时，并发落定合并走前门用户消息，投递前写 pending、成功后写 ack", async () => {
	const harness = await setup();
	harness.idle = true;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	faux.setResponses([
		async () => { await gate; return fauxAssistantMessage("结果 A"); },
		async () => { await gate; return fauxAssistantMessage("结果 B"); },
	]);
	await Promise.all([
		harness.execute({ action: "start", worker: "merge-a", prompt: "A", role: "工程师" }),
		harness.execute({ action: "start", worker: "merge-b", prompt: "B", role: "工程师" }),
	]);
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	release();
	await delivered;
	await Bun.sleep(0);
	expect(harness.messages).toEqual([]);
	expect(harness.userMessages).toHaveLength(1);
	expect(harness.userMessages[0]).toContain("结果 A");
	expect(harness.userMessages[0]).toContain("结果 B");
	expect(harness.appended.map(([type]) => type)).toEqual([
		"firecode-master-pending-event",
		"firecode-master-pending-event",
		"firecode-master-event-ack",
	]);
});

test("在飞 send 拒绝；interrupt 落中断标记、定时提醒，首次 send 自动注入现场自检", async () => {
	const harness = await setup(true, { interruptResumeMs: 10 });
	let resumedPrompt = "";
	faux.setResponses([
		async (_context: any, options: any) => {
			await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
			return fauxAssistantMessage("已中断");
		},
	]);
	await harness.execute({
		action: "start", worker: "interrupted", prompt: "开始", role: "工程师",
	});
	await expect(harness.execute({ action: "send", worker: "interrupted", prompt: "急件" }))
		.rejects.toThrow("急件先 interrupt 再 send");
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "interrupt", worker: "interrupted" });
	await delivered;
	expect(harness.messages.at(-1).message.content).toContain("已中断");
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(harness.messages.at(-1).message.content).toContain("自动续跑提醒");
	const reminded = (await harness.list().then((result) => result.details as any)).workers[0];
	expect(reminded.disposition).toBe("reminded");

	faux.setResponses([(context: any) => {
		resumedPrompt = context.messages.filter((message: any) => message.role === "user")
			.map((message: any) => typeof message.content === "string" ? message.content : message.content?.map((part: any) => part.text).join(""))
			.join("\n");
		return fauxAssistantMessage("续跑完成");
	}]);
	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "send", worker: "interrupted", prompt: "继续" });
	await delivered;
	expect(resumedPrompt).toContain("<firecode_master_event>");
	expect(resumedPrompt).toContain("上次被外部中断");
	expect(resumedPrompt).toContain("git status");
	expect(resumedPrompt).toContain("</firecode_master_event>");
	const listed = (await harness.list().then((result) => result.details as any)).workers[0];
	expect(listed.interruptedAt).toBeUndefined();
});

test("失败的 interrupt 不会把本回合或下一回合误记为中断", async () => {
	const harness = await setup();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	faux.setResponses([async () => {
		await gate;
		return fauxAssistantMessage("自然完成");
	}]);
	const started = await harness.execute({
		action: "start", worker: "abort-race", prompt: "执行", role: "工程师",
	});
	const session = harness.pool.getSession((started.details as any).worker.session);
	session.abort = async () => { throw new Error("abort failed"); };
	await expect(harness.execute({ action: "interrupt", worker: "abort-race" })).rejects.toThrow("abort failed");

	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	release();
	await delivered;
	expect(harness.messages.at(-1).message.content).toContain("自然完成");
	expect(harness.messages.at(-1).message.content).not.toContain("已中断");
	const worker = (await harness.list().then((result) => result.details as any)).workers[0];
	expect(worker.interruptedAt).toBeUndefined();
});

test("同一空闲 Worker 的并发 send 只接收一票，另一票按在飞拒绝", async () => {
	const harness = await setup();
	faux.setResponses([fauxAssistantMessage("初始完成")]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "start", worker: "single-flight", prompt: "初始化", role: "工程师",
	});
	await delivered;

	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	faux.setResponses([async () => {
		await gate;
		return fauxAssistantMessage("唯一结果");
	}]);
	const sends = await Promise.allSettled([
		harness.execute({ action: "send", worker: "single-flight", prompt: "第一票" }),
		harness.execute({ action: "send", worker: "single-flight", prompt: "第二票" }),
	]);
	expect(sends.filter((result) => result.status === "fulfilled")).toHaveLength(1);
	const rejected = sends.find((result) => result.status === "rejected") as PromiseRejectedResult;
	expect(String(rejected.reason)).toContain("急件先 interrupt 再 send");
	expect((await harness.list().then((result) => result.details as any)).workers[0].status).toBe("working");

	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	release();
	await delivered;
	expect(harness.messages.at(-1).message.content).toContain("唯一结果");
});

test("kill 赢过正在准备的 send/review，异步写回不会复活已删档案", async () => {
	const harness = await setup(true, { review: true, mockReview: true });
	faux.setResponses([fauxAssistantMessage("初始完成"), fauxAssistantMessage("待审完成")]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "start", worker: "kill-send", prompt: "初始化", role: "工程师",
	});
	await delivered;
	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "start", worker: "kill-review", prompt: "初始化", role: "工程师", review: true,
	});
	await delivered;

	faux.setResponses([fauxAssistantMessage("不应执行")]);
	const sending = harness.execute({
		action: "send", worker: "kill-send", prompt: "新任务", role: "架构师",
	});
	await harness.execute({ action: "kill", worker: "kill-send" });
	await expect(sending).rejects.toThrow("已被 kill");
	const reviewing = harness.execute({ action: "review", worker: "kill-review" });
	await harness.execute({ action: "kill", worker: "kill-review" });
	await expect(reviewing).rejects.toThrow("已被 kill");
	expect((await harness.list().then((result) => result.details as any)).workers).toEqual([]);
	expect(harness.messages).toHaveLength(2);
});

test("第 16 个在飞 Worker 被 admission 拒绝并回报当前清单", async () => {
	const harness = await setup();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	faux.setResponses(Array.from({ length: 15 }, (_, index) => async () => {
		await gate;
		return fauxAssistantMessage(`完成 ${index}`);
	}));
	const starts = await Promise.allSettled(Array.from({ length: 16 }, (_, index) => harness.execute({
		action: "start", worker: `slot-${index}`, prompt: "等待", role: "工程师",
	})));
	const rejected = starts.filter((result) => result.status === "rejected") as PromiseRejectedResult[];
	expect(rejected).toHaveLength(1);
	expect(String(rejected[0].reason)).toMatch(/并发上限 15.*slot-/);
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	release();
	await delivered;
});

test("fire-review 不可用时拒绝 start/send 挂审查义务", async () => {
	const harness = await setup();
	await expect(harness.execute({
		action: "start", worker: "blocked-review", prompt: "实现", role: "工程师", review: true,
	})).rejects.toThrow("fire-review 已关闭");
	faux.setResponses([fauxAssistantMessage("完成")]);
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "start", worker: "plain", prompt: "实现", role: "工程师",
	});
	await delivered;
	await expect(harness.execute({ action: "send", worker: "plain", prompt: "加审查义务", review: true }))
		.rejects.toThrow("fire-review 已关闭");
});

test("list 展开投影 reviewing 的轮次与审查者进度", async () => {
	const harness = await setup(true, { review: true, mockReview: true, reviewProgressOnly: true });
	faux.setResponses([fauxAssistantMessage("实现完成")]);
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "start", worker: "under-review", prompt: "实现", role: "工程师", review: true,
	});
	await delivered;
	await harness.execute({ action: "review", worker: "under-review" });

	const listed = await harness.list();
	expect(listed.content[0].text).not.toContain("currentAction");
	expect((listed.details as any).workers[0].currentAction).toEqual({
		kind: "review", round: 1, settled: 0, total: 1,
	});
	const expanded = harness.renderResult(listed, true).join("\n");
	expect(expanded).toContain("第 1 轮");
	expect(expanded).toContain("审查者 0/1");
});

test("审查义务只能经显式 review 履行，未履行拒绝 ack，kill 随票删除", async () => {
	const harness = await setup(true, { review: true, mockReview: true });
	faux.setResponses([fauxAssistantMessage("实现完成"), fauxAssistantMessage("待删除")]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "start", worker: "obligation", prompt: "实现", role: "工程师", review: true,
	});
	await delivered;
	expect(harness.messages).toHaveLength(1);
	expect(harness.messages[0].message.content).toContain("此票有审查义务");
	await expect(harness.execute({ action: "ack", worker: "obligation" })).rejects.toThrow("完成 review 后才能 ack");

	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "review", worker: "obligation" });
	await delivered;
	expect(harness.messages).toHaveLength(2);
	expect(harness.messages[1].message.content).toContain("审查通过（1 轮）");
	await harness.execute({ action: "ack", worker: "obligation" });

	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "start", worker: "discard-obligation", prompt: "实现", role: "工程师", review: true,
	});
	await delivered;
	await harness.execute({ action: "kill", worker: "discard-obligation" });
	expect((await harness.list().then((result) => result.details as any)).workers)
		.not.toContainEqual(expect.objectContaining({ name: "discard-obligation" }));
});

test("review 命令未启动时明确失败结算并保留审查义务", async () => {
	const harness = await setup(true, { review: true });
	faux.setResponses([fauxAssistantMessage("实现完成"), fauxAssistantMessage("未启动审查")]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "start", worker: "review-missing", prompt: "实现", role: "工程师", review: true,
	});
	await delivered;

	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "review", worker: "review-missing" });
	await Promise.race([
		delivered,
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error("审查失败未回传")), 100)),
	]);
	expect(harness.messages.at(-1).message.content).toContain("审查未启动");
	const worker = (await harness.list().then((result) => result.details as any)).workers[0];
	expect(worker).toMatchObject({ status: "idle", reviewNeeded: true, disposition: "pending" });
});

test("crash 恢复只重投 pending 减 ack 的差集", async () => {
	const harness = await setup(false);
	harness.entries.push(
		{ type: "custom", customType: "firecode-master-pending-event", data: { id: "e1", content: "未确认结果" } },
		{ type: "custom", customType: "firecode-master-pending-event", data: { id: "e2", content: "已确认结果" } },
		{ type: "custom", customType: "firecode-master-event-ack", data: { ids: ["e2"] } },
	);
	const delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.emit("session_start", {});
	await delivered;
	await Bun.sleep(0);
	expect(harness.messages.map((entry) => entry.message.content)).toEqual([
		"<firecode_master_event>\n未确认结果\n</firecode_master_event>",
	]);
	expect(harness.appended).toEqual([["firecode-master-event-ack", { ids: ["e1"] }]]);
});

test("send 只覆盖 thinking 时沿用当前角色与模型", async () => {
	const harness = await setup();
	faux.setResponses([fauxAssistantMessage("第一轮"), fauxAssistantMessage("升档完成")]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const started = await harness.execute({
		action: "start", worker: "thinking-only", prompt: "初始化", role: "工程师",
	});
	await delivered;

	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "send", worker: "thinking-only", prompt: "继续", thinking: "high",
	});
	await delivered;

	const worker = (await harness.list().then((result) => result.details as any)).workers[0];
	expect(worker).toMatchObject({
		status: "idle", role: "工程师", model: "test/worker", thinking: "high",
		session: (started.details as any).worker.session,
	});
	const sessionText = await Bun.file(worker.session).text();
	expect(sessionText.match(/"type":"model_change"/gu)).toHaveLength(1);
});

test("send 对冷 Worker 透明复活、省略角色沿用、显式角色原地切换并入会话记录", async () => {
	const harness = await setup(true, { idleTimeoutMs: 10 });
	faux.setResponses([
		fauxAssistantMessage("第一轮"),
		fauxAssistantMessage("沿用完成"),
		fauxAssistantMessage("切换完成"),
	]);
	let delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	const started = await harness.execute({
		action: "start", worker: "revive", prompt: "第一轮", role: "工程师",
	});
	await delivered;
	const sessionPath = (started.details as any).worker.session;
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(harness.pool.has(sessionPath)).toBe(false);

	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({ action: "send", worker: "revive", prompt: "沿用" });
	await delivered;
	let listed = (await harness.list().then((result) => result.details as any)).workers[0];
	expect(listed).toMatchObject({ status: "idle", role: "工程师" });

	delivered = new Promise<void>((resolve) => { harness.onMessage = () => resolve(); });
	await harness.execute({
		action: "send", worker: "revive", prompt: "切换", role: "架构师",
	});
	await delivered;
	listed = (await harness.list().then((result) => result.details as any)).workers[0];
	expect(listed).toMatchObject({ status: "idle", role: "架构师" });
	const sessionText = await Bun.file(sessionPath).text();
	expect(sessionText).toContain('"type":"model_change"');
	expect(sessionText).toContain('"type":"thinking_level_change"');
});

test("v7 状态由所有者丢弃并告知旧进程不纳入新池", async () => {
	const harness = await setup(false);
	const state = await loadFirecodeModule("master/state.js") as any;
	const path = state.masterStatePath(harness.sessionId);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify({ version: 7, workers: [] }));
	try {
		await harness.command("");
		expect(harness.notices.join("\n")).toContain("旧版 v7 子代理池已丢弃");
		expect(harness.notices.join("\n")).toContain("旧运行时进程不会纳入新池");
		expect(await readdir(dirname(path))).not.toContain(path.split("/").pop());
	} finally {
		await rm(path, { force: true });
	}
});

test("显式 observer 角色不注册 Master 工具面", async () => {
	const harness = await loadFirecodeModule("role-harness.js", {
		configJsonc: JSON.stringify({
			features: {
				header: false, statusbar: false, tools: false, presets: false, rename: false,
				stats: false, claudeSub: false, openaiNative: false, workingFlame: false,
				bark: false, review: false, master: true, watcher: false,
			},
			review: TEST_REVIEW_CONFIG,
			master: { roles: { 工程师: TEST_ROLES.工程师 }, workerExcludeExtensions: [], autoActivate: true },
		}),
		extraFiles: {
			"role-harness.ts": [
				'import firecode from "./index.js";',
				'import { withSubsessionRole } from "./master/role.js";',
				'export const register = (pi: unknown) => withSubsessionRole("observer", async () => firecode(pi as never));',
			].join("\n"),
		},
	}) as { register: (pi: unknown) => Promise<void> };
	const commands = new Map<string, unknown>();
	const tools = new Map<string, unknown>();
	const handlers = new Map<string, unknown[]>();
	await harness.register({
		registerMessageRenderer() {}, registerEntryRenderer() {}, registerShortcut() {},
		registerCommand: (name: string, command: unknown) => commands.set(name, command),
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
		getActiveTools: () => [], setActiveTools() {},
		on: (name: string, handler: unknown) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		events: { on() {}, emit() {} },
	});
	expect(commands.has("fire-master")).toBe(false);
	expect(tools.has("subagents")).toBe(false);
	expect(handlers.has("tool_call")).toBe(true);
});

test("Worker 会话只注册 checkout 守卫，不暴露 Master 工具面", async () => {
	directory = await mkdtemp(join(tmpdir(), "firecode-worker-guard-"));
	const cwd = join(directory, "checkout");
	await mkdir(cwd);
	const module = await loadFirecodeModule("master/index.js", {
		configJsonc: JSON.stringify({
			features: { master: true, review: false },
			review: TEST_REVIEW_CONFIG,
			master: { roles: TEST_ROLES },
		}),
	}) as any;
	const register = (worker = false) => {
		const handlers = new Map<string, any[]>();
		const commands = new Map<string, any>();
		const tools = new Map<string, any>();
		module.registerMaster({
			registerMessageRenderer() {},
			registerCommand: (name: string, command: any) => commands.set(name, command),
			registerTool: (tool: any) => tools.set(tool.name, tool),
			getActiveTools: () => [], setActiveTools() {},
			on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
			events: { on() {}, emit() {} },
		}, {}, worker);
		return { handlers, commands, tools };
	};

	const workerRegistration = register(true);
	const ctx = { cwd };
	expect(workerRegistration.commands.size).toBe(0);
	expect(workerRegistration.tools.size).toBe(0);
	expect(workerRegistration.handlers.has("session_start")).toBe(false);
	const workerGuard = workerRegistration.handlers.get("tool_call")?.[0];
	expect(await workerGuard({ toolName: "write", input: { path: "../outside.ts" } }, ctx)).toEqual({
		block: true,
		reason: "子代理只能修改当前 checkout：../outside.ts",
	});
	expect(await workerGuard({ toolName: "edit", input: { path: "inside.ts" } }, ctx)).toBeUndefined();

	const masterRegistration = register();
	expect(masterRegistration.commands.has("fire-master")).toBe(true);
	expect(masterRegistration.tools.has("subagents")).toBe(true);
	expect(masterRegistration.handlers.get("tool_call")).toBeUndefined();
});

async function setup(activate = true, options: {
	idleTimeoutMs?: number;
	interruptResumeMs?: number;
	review?: boolean;
	mockReview?: boolean;
	reviewProgressOnly?: boolean;
	autoActivate?: boolean;
	deferUserMessage?: boolean;
	promptFiles?: Record<string, string>;
	roles?: Record<string, { model: string; use: string; fallback?: string[] }>;
} = {}) {
	directory = await mkdtemp(join(tmpdir(), "firecode-master-sdk-"));
	const cwd = join(directory, "project");
	const agentDir = join(directory, "agent");
	const sessionDir = join(directory, "sessions");
	await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir)]);
	if (options.mockReview) {
		const extensions = join(agentDir, "extensions");
		await mkdir(extensions);
		await writeFile(join(extensions, "mock-review.ts"), mockReviewExtension(options.reviewProgressOnly === true));
	}
	await writeFile(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "faux-key" } }));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	faux = registerFauxProvider();
	const { ModelRuntime, SessionManager } = await import(PI_CODING_AGENT_URL) as any;
	const spawnModule = await loadFirecodeModule("master/spawn.js");
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
	const fauxModel = faux.getModel();
	const alternateModel = { ...fauxModel, id: "worker-2", name: "Worker 2" };
	modelRuntime.registerProvider(fauxModel.provider, {
		baseUrl: fauxModel.baseUrl,
		api: fauxModel.api,
		models: [fauxModel, alternateModel].map((model) => ({
			id: model.id,
			name: model.name,
			api: model.api,
			reasoning: model.reasoning,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			baseUrl: model.baseUrl,
		})),
	});
	if (!modelRuntime.hasConfiguredAuth("faux")) throw new Error("测试 Faux 模型认证未载入");
	const pool = new (spawnModule as any).InProcessSessionPool({
		agentDir,
		modelRuntime,
		...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
	});
	const module = await loadFirecodeModule("master/index.js", {
		extraFiles: options.promptFiles,
		configJsonc: JSON.stringify({
			features: { master: true, review: options.review === true },
			review: TEST_REVIEW_CONFIG,
			master: {
				roles: options.roles ?? TEST_ROLES,
				workerExcludeExtensions: [],
				...(options.autoActivate === undefined ? {} : { autoActivate: options.autoActivate }),
			},
		}),
	}) as any;
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	const notices: string[] = [];
	const messages: any[] = [];
	const appended: Array<[string, any]> = [];
	const entries: any[] = [];
	const userMessages: string[] = [];
	let onMessage: (() => void) | undefined;
	let idle = false;
	let releaseUserMessage = () => {};
	const userMessageGate = options.deferUserMessage
		? new Promise<void>((resolve) => { releaseUserMessage = resolve; })
		: Promise.resolve();
	let markUserMessageStarted!: () => void;
	const userMessageStarted = new Promise<void>((resolve) => { markUserMessageStarted = resolve; });
	let activeTools = ["read", "bash", "edit", "write"];
	const pi = {
		registerMessageRenderer() {},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		getActiveTools: () => [...activeTools],
		setActiveTools: (next: string[]) => { activeTools = next; },
		on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		events: { on() {}, emit() {} },
		appendEntry: (type: string, data: any) => {
			appended.push([type, data]);
			entries.push({ type: "custom", customType: type, data });
		},
		sendMessage: (message: any, options: any) => { messages.push({ message, options }); onMessage?.(); },
		sendUserMessage: async (content: string) => {
			userMessages.push(content);
			markUserMessageStarted();
			await userMessageGate;
			onMessage?.();
		},
	};
	let sessionId = crypto.randomUUID();
	const main = SessionManager.create(cwd, sessionDir);
	const ctx = {
		cwd,
		isIdle: () => idle,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => main.getSessionFile(),
			getEntries: () => entries,
		},
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus() {},
			theme: {
				fg: (_color: string, text: string) => text,
				bg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
		},
	};
	module.registerMaster(pi, {
		resolveModel: async (id: string) => id === "test/worker-2" ? alternateModel : fauxModel,
		pool,
		...(options.interruptResumeMs === undefined ? {} : { interruptResumeMs: options.interruptResumeMs }),
	});
	const command = (args: string) => commands.get("fire-master").handler(args, ctx);
	if (activate) await command("");
	return {
		cwd,
		get sessionId() { return sessionId; },
		notices,
		messages,
		userMessages,
		appended,
		entries,
		pool,
		set onMessage(value: (() => void) | undefined) { onMessage = value; },
		set idle(value: boolean) { idle = value; },
		userMessageStarted,
		releaseUserMessage,
		command,
		emit: async (name: string, event: any) => {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
		replaceSession: async () => {
			sessionId = crypto.randomUUID();
			entries.length = 0;
			for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
		},
		agentDir,
		model: fauxModel,
		modelRuntime,
		commandTool: tools.get("subagents"),
		listTool: tools.get("subagents_list"),
		toolDescription: tools.get("subagents").description as string,
		parameterDescriptions: Object.fromEntries(Object.entries(tools.get("subagents").parameters.properties)
			.map(([name, schema]: [string, any]) => [name, schema.description])) as Record<string, string>,
		systemPrompt: async (initial: string) => {
			let event = { systemPrompt: initial };
			for (const handler of handlers.get("before_agent_start") ?? []) {
				const result = await handler(event, ctx);
				if (result?.systemPrompt) event = { systemPrompt: result.systemPrompt };
			}
			return event.systemPrompt;
		},
		renderResult: (result: any, expanded: boolean) => tools.get("subagents_list").renderResult(
			result,
			{ expanded },
			ctx.ui.theme,
			{ state: {}, cwd, toolCallId: "list", isPartial: false, isError: false, expanded },
		).render(120),
		renderListLine: (result: any) => {
			const context = { state: {}, cwd, toolCallId: "list", isPartial: false, isError: false, expanded: false };
			tools.get("subagents_list").renderResult(result, { expanded: false }, ctx.ui.theme, context);
			return tools.get("subagents_list").renderCall({}, ctx.ui.theme, context).render(120);
		},
		list: () => tools.get("subagents_list").execute("list", {}, undefined, undefined, ctx),
		execute: (params: Record<string, unknown>) => tools.get("subagents").execute("call", params, undefined, undefined, ctx),
	};
}

function mockReviewExtension(progressOnly = false): string {
	const base = {
		version: 5, runId: "mock-review-run", round: 1, focus: "", pending: null, repair: null, summary: null,
		consecutiveFailures: 0, startedAt: 1, roundStartedAt: 1,
	};
	const reviewing = {
		...base, seq: 1, phase: "reviewing", history: [], updatedAt: 1,
		active: { round: 1, reviewers: [{ index: 0, model: "test/reviewer", thinking: "high", status: "running", result: null }], settledCount: 0 },
	};
	const settled = {
		...base, seq: 2, phase: "settled", active: null, updatedAt: 2,
		history: [{
			round: 1, result: "passed", details: "verified", elapsedMs: 1,
			reviewers: [{ index: 0, model: "test/reviewer", thinking: "high", status: "passed", summary: "ok", details: "verified" }],
		}],
	};
	return `export default function(pi) {
		pi.registerCommand("fire-review", {
			description: "mock review",
			handler: () => {
				pi.appendEntry("firecode-review-checkpoint", ${JSON.stringify(reviewing)});
				${progressOnly ? "" : `pi.appendEntry("firecode-review-checkpoint", ${JSON.stringify(settled)});`}
			},
		});
	}`;
}
