import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { masterEventDetails } from "../master/event-format.js";
import { HerdrWorkers } from "../master/herdr.js";
import { MasterStore, type WorkerRef } from "../master/state.js";

const savedShell = process.env.SHELL;
const statePaths: string[] = [];
afterEach(async () => {
	if (savedShell === undefined) delete process.env.SHELL;
	else process.env.SHELL = savedShell;
	for (const path of statePaths.splice(0)) await rm(path, { force: true });
});

function createStore(): MasterStore {
	const path = join(tmpdir(), `firecode-master-test-${crypto.randomUUID()}.json`);
	statePaths.push(path);
	return new MasterStore(path);
}

function worker(status: WorkerRef["status"] = "working"): WorkerRef {
	return {
		name: "worker-1",
		paneId: "w1:p2",
		tabId: "w1:t2",
		sessionPath: "/tmp/worker.jsonl",
		model: "openai-codex/gpt-4.1",
		thinking: "medium",
		status,
	};
}

function response(value: unknown) {
	return { code: 0, stdout: JSON.stringify(value), stderr: "", killed: false };
}

function missingAgent() {
	return {
		code: 1,
		stdout: "",
		stderr: JSON.stringify({ error: { code: "agent_not_found", message: "not found" } }),
		killed: false,
	};
}

test("a missing live process becomes a resumable Dormant Worker", async () => {
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: worker() });
	const notices: string[] = [];
	const pool = new HerdrWorkers({
		pi: { exec: async () => missingAgent() } as never,
		store,
		workspaceId: "w1",
		notifyMaster: (content) => notices.push(content),
	});
	await pool.resume();
	expect(store.state.workers[0]).toMatchObject({
		name: "worker-1",
		status: "dormant",
		sessionPath: "/tmp/worker.jsonl",
	});
	expect(notices.join()).toContain("进程已不存在");
});

test("recovery cleans a missing split startup without closing its shared tab", async () => {
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: worker("idle") });
	store.dispatch({ type: "UPSERT_WORKER", worker: {
		...worker("starting"),
		name: "worker-2",
		paneId: "w1:p3",
		sessionPath: undefined,
	} });
	const calls: string[][] = [];
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[]) => {
			calls.push(args);
			if (args[0] === "agent" && args[1] === "get") return missingAgent();
			if (args[0] === "tab" && args[1] === "list") return response({ result: { tabs: [] } });
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	await pool.resume();
	expect(calls).toContainEqual(["pane", "close", "w1:p3"]);
	expect(calls.some((args) => args[0] === "tab" && args[1] === "close")).toBe(false);
	expect(store.state.workers.map((item) => item.name)).toEqual(["worker-1"]);
});

test("a live working Worker keeps being watched after reload", async () => {
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: worker() });
	const calls: string[][] = [];
	const pool = new HerdrWorkers({
		pi: {
			exec: async (_command: string, args: string[], options: { signal?: AbortSignal }) => {
				calls.push(args);
				if (args[0] === "agent" && args[1] === "get") return liveAgent();
				if (args[0] === "agent" && args[1] === "wait")
					return new Promise((resolve) =>
						options.signal?.addEventListener("abort", () => resolve(response({})), { once: true }),
					);
				return response({});
			},
		} as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	await pool.resume();
	expect(store.state.workers[0]?.status).toBe("working");
	expect(calls.some((args) => args[0] === "agent" && args[1] === "wait")).toBe(true);
	pool.shutdown();
});

test("start can resume a Dormant Worker with its exact Pi session", async () => {
	process.env.SHELL = "/bin/zsh";
	const store = createStore();
	store.dispatch({
		type: "UPSERT_WORKER",
		worker: {
			name: "worker-1",
			model: "openai-codex/gpt-4.1",
			thinking: "high",
			status: "dormant",
			sessionPath: "/tmp/worker.jsonl",
		},
	});
	const calls: string[][] = [];
	const pool = new HerdrWorkers({
		pi: {
			exec: async (_command: string, args: string[], options: { signal?: AbortSignal }) => {
				calls.push(args);
				if (args[0] === "tab" && args[1] === "create")
					return response({ result: { root_pane: { pane_id: "w1:p2" }, tab: { tab_id: "w1:t2" } } });
				if (args[0] === "pane" && args[1] === "wait-output") return response({});
				if (args[0] === "agent" && args[1] === "start") return liveAgent();
				if (args[0] === "agent" && args[1] === "prompt")
					return new Promise((resolve) =>
						options.signal?.addEventListener("abort", () => resolve(response({})), { once: true }),
					);
				return response({});
			},
		} as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	await pool.start({ cwd: "/tmp", model: { provider: "xai", id: "grok" }, thinkingLevel: "low" } as never, {
		prompt: "继续检查",
		session: "worker-1",
	});
	const start = calls.find((args) => args[0] === "agent" && args[1] === "start") ?? [];
	expect(start.slice(start.indexOf("--session"), start.indexOf("--session") + 2)).toEqual([
		"--session",
		"/tmp/worker.jsonl",
	]);
	// Worker 用 pi 默认工具集（ADR-0004），不再传 --tools 白名单。
	expect(start).not.toContain("--tools");
	expect(calls.some((args) => args[0] === "pane" && args[1] === "split")).toBe(false);
	expect(store.state.workers[0]).toMatchObject({ status: "working", thinking: "high" });
	pool.shutdown();
});

test("new Workers fill the current tab to four panes before opening another", async () => {
	process.env.SHELL = "/bin/zsh";
	const store = createStore();
	const calls: string[][] = [];
	const paneTabs = new Map<string, string>();
	let tabSerial = 0;
	let paneSerial = 0;
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[], options: { signal?: AbortSignal }) => {
			calls.push(args);
			if (args[0] === "tab" && args[1] === "create") {
				const tabId = `w1:t${++tabSerial}`;
				const paneId = `w1:p${++paneSerial}`;
				paneTabs.set(paneId, tabId);
				return response({ result: { root_pane: { pane_id: paneId }, tab: { tab_id: tabId } } });
			}
			if (args[0] === "pane" && args[1] === "split") {
				const paneId = `w1:p${++paneSerial}`;
				paneTabs.set(paneId, paneTabs.get(args[2] as string) as string);
				return response({ result: { pane: { pane_id: paneId } } });
			}
			if (args[0] === "pane" && (args[1] === "wait-output" || args[1] === "close")) return response({});
			if (args[0] === "agent" && args[1] === "start") {
				const paneId = args[args.indexOf("--pane") + 1] as string;
				const name = args[2] as string;
				return agentResponse(paneId, paneTabs.get(paneId) as string, `/tmp/${name}.jsonl`);
			}
			if (args[0] === "agent" && args[1] === "get") {
				const paneId = args[2] as string;
				const item = store.state.workers.find((candidate) => candidate.paneId === paneId);
				return agentResponse(paneId, paneTabs.get(paneId) as string, item?.sessionPath ?? "");
			}
			if (args[0] === "agent" && args[1] === "prompt")
				return new Promise((resolve) => options.signal?.addEventListener("abort", () => resolve(response({})), { once: true }));
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	const ctx = { cwd: "/tmp", model: { provider: "p", id: "m" }, thinkingLevel: "medium" } as never;
	for (let serial = 1; serial <= 5; serial += 1)
		await pool.start(ctx, { name: `worker-${serial}`, model: "p/m", thinking: "medium", prompt: "做" });
	await pool.stop("worker-2", true);
	await pool.start(ctx, { name: "worker-6", model: "p/m", thinking: "medium", prompt: "做" });

	const layout = calls.filter((args) =>
		(args[0] === "tab" && args[1] === "create") || (args[0] === "pane" && args[1] === "split")
	);
	// 2×2 象限：右切 p1、下切 p1、下切 p2；嵌套同向切会把后来者挤成 1/8 宽。
	expect(layout.map((args) => [
		...args.slice(0, 3),
		args.includes("--direction") ? args[args.indexOf("--direction") + 1] : "",
	])).toEqual([
		["tab", "create", "--workspace", ""],
		["pane", "split", "w1:p1", "right"],
		["pane", "split", "w1:p1", "down"],
		["pane", "split", "w1:p2", "down"],
		["tab", "create", "--workspace", ""],
		["pane", "split", "w1:p5", "right"],
	]);
	expect(layout[0]?.slice(0, 9)).toEqual([
		"tab", "create", "--workspace", "w1", "--cwd", "/tmp", "--label", "worker-1-m", "--env",
	]);
	// pane/tab/Pi 统一显示名：任务名-模型名；两种 shell 形态的 pane 都要命名。
	expect(calls).toContainEqual(["pane", "rename", "w1:p1", "worker-1-m"]);
	expect(calls).toContainEqual(["pane", "rename", "w1:p2", "worker-2-m"]);
	// 第二个工人加入后 tab 变分组：标签改组名，不再冒用首工人名字。
	expect(calls).toContainEqual(["tab", "rename", "w1:t1", "子代理"]);
	// agent 名同样携带模型（Herdr 字符集内）；Pi 名为完整显示名加 ↳ 前缀。
	const start = calls.find((args) => args[0] === "agent" && args[1] === "start" && args[2] === "worker-1-m");
	expect(start?.slice(start.indexOf("--name"), start.indexOf("--name") + 2)).toEqual(["--name", "↳worker-1-m"]);
	expect(layout[1]?.slice(0, 8)).toEqual([
		"pane", "split", "w1:p1", "--direction", "right", "--cwd", "/tmp", "--env",
	]);
	expect(layout[1]?.at(-1)).toBe("--no-focus");
	expect(calls).toContainEqual(["pane", "close", "w1:p2"]);
	pool.shutdown();
});

test("a failed split falls back to a new tab", async () => {
	process.env.SHELL = "/bin/zsh";
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: worker("idle") });
	const calls: string[][] = [];
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[], options: { signal?: AbortSignal }) => {
			calls.push(args);
			if (args[0] === "pane" && args[1] === "split")
				return { code: 1, stdout: "", stderr: "split unavailable", killed: false };
			if (args[0] === "tab" && args[1] === "create")
				return response({ result: { root_pane: { pane_id: "w1:p3" }, tab: { tab_id: "w1:t3" } } });
			if (args[0] === "pane" && args[1] === "wait-output") return response({});
			if (args[0] === "agent" && args[1] === "start") return agentResponse("w1:p3", "w1:t3", "/tmp/worker-2.jsonl");
			if (args[0] === "agent" && args[1] === "prompt")
				return new Promise((resolve) => options.signal?.addEventListener("abort", () => resolve(response({})), { once: true }));
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	await pool.start({ cwd: "/tmp", model: { provider: "p", id: "m" }, thinkingLevel: "medium" } as never, {
		name: "worker-2",
		model: "p/m",
		thinking: "medium",
		prompt: "做",
	});
	expect(calls.filter((args) =>
		(args[0] === "pane" && args[1] === "split") || (args[0] === "tab" && args[1] === "create")
	).map((args) => args.slice(0, 2))).toEqual([["pane", "split"], ["tab", "create"]]);
	expect(store.state.workers.find((item) => item.name === "worker-2")).toMatchObject({ status: "working", tabId: "w1:t3" });
	pool.shutdown();
});

test("startup failure closes only the shell shape it created", async () => {
	process.env.SHELL = "/bin/zsh";
	for (const shape of ["tab", "pane"] as const) {
		const store = createStore();
		if (shape === "pane") store.dispatch({ type: "UPSERT_WORKER", worker: worker("idle") });
		const calls: string[][] = [];
		const pool = new HerdrWorkers({
			pi: { exec: async (_command: string, args: string[]) => {
				calls.push(args);
				if (args[0] === "tab" && args[1] === "create")
					return response({ result: { root_pane: { pane_id: "w1:p3" }, tab: { tab_id: "w1:t3" } } });
				if (args[0] === "pane" && args[1] === "split") return response({ result: { pane: { pane_id: "w1:p3" } } });
				if (args[0] === "pane" && args[1] === "wait-output") return response({});
				if (args[0] === "agent" && args[1] === "start")
					return { code: 1, stdout: "", stderr: "start failed", killed: false };
				return response({});
			} } as never,
			store,
			workspaceId: "w1",
			notifyMaster() {},
		});
		await expect(pool.start({ cwd: "/tmp", model: { provider: "p", id: "m" }, thinkingLevel: "medium" } as never, {
			name: "worker-2",
			model: "p/m",
			thinking: "medium",
			prompt: "做",
		})).rejects.toThrow("start failed");
		expect(calls).toContainEqual(shape === "pane"
			? ["pane", "close", "w1:p3"]
			: ["tab", "close", "w1:t3"]);
		expect(calls.some((args) => args[0] === (shape === "pane" ? "tab" : "pane") && args[1] === "close")).toBe(false);
	}
});

test("resuming under a new name replaces the old Dormant identity", async () => {
	process.env.SHELL = "/bin/zsh";
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: {
		name: "worker-1",
		model: "p/m",
		thinking: "medium",
		status: "dormant",
		sessionPath: "/tmp/worker.jsonl",
	} });
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[], options: { signal?: AbortSignal }) => {
			if (args[0] === "tab") return response({ result: { root_pane: { pane_id: "w1:p2" }, tab: { tab_id: "w1:t2" } } });
			if (args[0] === "pane") return response({});
			if (args[0] === "agent" && args[1] === "start") return liveAgent();
			if (args[0] === "agent" && args[1] === "prompt")
				return new Promise((resolve) => options.signal?.addEventListener("abort", () => resolve(response({})), { once: true }));
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	await pool.start({ cwd: "/tmp", model: { provider: "p", id: "m" }, thinkingLevel: "medium" } as never, {
		name: "renamed-worker",
		prompt: "继续",
		session: "worker-1",
	});
	expect(store.state.workers.map((item) => item.name)).toEqual(["renamed-worker"]);
	pool.shutdown();
});

test("a failed renamed resume restores only the original Dormant identity", async () => {
	process.env.SHELL = "/bin/zsh";
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: {
		name: "worker-1",
		model: "p/m",
		thinking: "medium",
		status: "dormant",
		sessionPath: "/tmp/worker.jsonl",
	} });
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[]) => {
			if (args[0] === "tab") return response({ result: { root_pane: { pane_id: "w1:p2" }, tab: { tab_id: "w1:t2" } } });
			if (args[0] === "pane") return response({});
			if (args[0] === "agent" && args[1] === "start") return { code: 1, stdout: "", stderr: "start failed", killed: false };
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	await expect(pool.start({ cwd: "/tmp", model: { provider: "p", id: "m" }, thinkingLevel: "medium" } as never, {
		name: "renamed-worker",
		prompt: "继续",
		session: "worker-1",
	})).rejects.toThrow("start failed");
	expect(store.state.workers).toEqual([{
		name: "worker-1",
		model: "p/m",
		thinking: "medium",
		status: "dormant",
		sessionPath: "/tmp/worker.jsonl",
	}]);
});

test("tail returns the trace since the last external input, error first", async () => {
	const directory = await mkdtemp(join(tmpdir(), "firecode-worker-tail-"));
	const sessionPath = join(directory, "worker.jsonl");
	const delegation = `写文档：${"边界条件".repeat(80)}`;
	await writeFile(sessionPath, [
		{ type: "session", version: 3, id: "s" },
		{ type: "session_info", id: "n0", parentId: null, name: "↳worker-1" },
		{ type: "message", id: "n1", parentId: "n0", message: { role: "user", content: [{ type: "text", text: "上一轮的旧委派" }] } },
		{ type: "message", id: "n2", parentId: "n1", message: { role: "assistant", content: [{ type: "text", text: "旧回复" }], stopReason: "stop" } },
		{ type: "message", id: "n3", parentId: "n2", message: { role: "user", content: [{ type: "text", text: delegation }] } },
		{ type: "custom", customType: "firecode-review-checkpoint", id: "n4", parentId: "n3", data: { phase: "queued" } },
		{ type: "message", id: "n5", parentId: "n4", message: { role: "assistant", content: [
			{ type: "thinking", thinking: "不入近况" },
			{ type: "toolCall", name: "bash", arguments: { command: "ls docs/" } },
		] } },
		{ type: "message", id: "n6", parentId: "n5", message: { role: "toolResult", content: [{ type: "text", text: "landing.md" }] } },
		{ type: "message", id: "n7", parentId: "n6", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Codex error: usage limit" } },
	].map((entry) => JSON.stringify(entry)).join("\n"));
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: { ...worker("idle"), sessionPath } });
	const pool = new HerdrWorkers({
		pi: { exec: async () => { throw new Error("tail 不得调 herdr"); } } as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	const trace = await pool.tail("worker-1");
	expect(trace.split("\n").slice(0, 3)).toEqual([
		"子代理 worker-1 近况（idle）",
		"状态：error｜Codex error: usage limit",
		`上一条指令：${delegation.slice(0, 250)}…`,
	]);
	expect(trace).toContain('→ bash {"command":"ls docs/"}');
	expect(trace).toContain("← landing.md");
	// 边界之前的旧回合与纯状态条目不得渗进来。
	expect(trace).not.toContain("旧回复");
	expect(trace).not.toContain("不入近况");
	store.dispatch({ type: "UPSERT_WORKER", worker: { name: "starting-1", model: "p/m", thinking: "medium", status: "starting", paneId: "starting", tabId: "starting" } });
	await expect(pool.tail("starting-1")).rejects.toThrow("还没有会话可读");
	// 审查注入同样是边界，且宿主允许其正文是富内容数组：锚点不得退化成空。
	const reviewPath = join(directory, "under-review.jsonl");
	await writeFile(reviewPath, [
		{ type: "message", id: "r1", message: { role: "user", content: [{ type: "text", text: "最初的委派" }] } },
		{ type: "custom_message", customType: "firecode-review-feedback", id: "r2", parentId: "r1", content: [{ type: "text", text: "本轮审查未通过" }] },
		{ type: "message", id: "r3", parentId: "r2", message: { role: "assistant", content: [{ type: "text", text: "已修复" }], stopReason: "stop" } },
	].map((entry) => JSON.stringify(entry)).join("\n"));
	store.dispatch({ type: "UPSERT_WORKER", worker: { ...worker("reviewing"), name: "worker-2", sessionPath: reviewPath } });
	expect(await pool.tail("worker-2")).toBe([
		"子代理 worker-2 近况（reviewing）",
		"审查注入：本轮审查未通过",
		"已修复",
	].join("\n"));
	await rm(directory, { recursive: true, force: true });
});

test("review submits only the literal command and waits past blocked states", async () => {
	const directory = await mkdtemp(join(tmpdir(), "firecode-worker-review-"));
	const sessionPath = join(directory, "worker.jsonl");
	const fixture = await readFile(join(import.meta.dir, "fixtures/review-outcomes/passed.jsonl"), "utf8");
	await writeFile(sessionPath, '{"type":"session","version":3,"id":"worker"}\n');
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: { ...worker("idle"), sessionPath } });
	const calls: string[][] = [];
	let releaseWait!: () => void;
	const wait = new Promise<ReturnType<typeof liveAgent>>((resolve) => {
		releaseWait = () => resolve(liveAgent("done", sessionPath));
	});
	let resolveNotice!: (value: string) => void;
	const notice = new Promise<string>((resolve) => { resolveNotice = resolve; });
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[]) => {
			calls.push(args);
			if (args[0] === "agent" && args[1] === "prompt") return response({});
			if (args[0] === "agent" && args[1] === "wait") return wait;
			if (args[0] === "agent" && args[1] === "get") return liveAgent(undefined, sessionPath);
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster: resolveNotice,
	});
	await pool.review("worker-1");
	expect(store.state.workers[0]?.status).toBe("reviewing");
	expect(calls.slice(0, 2)).toEqual([
		["agent", "prompt", "w1:p2", "/fire-review", "--wait", "--until", "working", "--until", "blocked", "--timeout", "8000"],
		["agent", "wait", "w1:p2", "--until", "idle", "--until", "done"],
	]);
	await expect(pool.send("worker-1", "顺便改一下")).rejects.toThrow("正在对抗审查，期间不能接收消息");
	await writeFile(sessionPath, `${fixture}${JSON.stringify({
		id: "assistant-1",
		message: { role: "assistant", content: [{ type: "text", text: "实现完成" }], stopReason: "stop" },
	})}\n`);
	releaseWait();
	expect(await notice).toContain("审查结束：通过");
	expect(await notice).toContain("最终回复：\n实现完成");
	expect(store.state.workers[0]?.status).toBe("idle");
	await rm(directory, { recursive: true, force: true });
});

test("a settled checkpoint from an older run cannot pass a review that never started", async () => {
	const directory = await mkdtemp(join(tmpdir(), "firecode-worker-stale-review-"));
	const sessionPath = join(directory, "worker.jsonl");
	const fixture = await readFile(join(import.meta.dir, "fixtures/review-outcomes/passed.jsonl"), "utf8");
	await writeFile(sessionPath, fixture);
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: { ...worker("idle"), sessionPath } });
	let resolveNotice!: (value: string) => void;
	const notice = new Promise<string>((resolve) => { resolveNotice = resolve; });
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[]) => {
			if (args[0] === "agent" && args[1] === "wait") return liveAgent("idle", sessionPath);
			if (args[0] === "agent" && args[1] === "get") return liveAgent(undefined, sessionPath);
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster: resolveNotice,
	});
	await pool.review("worker-1");
	expect(await notice).toContain("审查未启动");
	expect(store.state.workers[0]?.status).toBe("idle");
	await rm(directory, { recursive: true, force: true });
});

test("stopping a Worker mid-startup aborts the start and leaves no orphan", async () => {
	process.env.SHELL = "/bin/zsh";
	const store = createStore();
	const calls: string[][] = [];
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[], options: { signal?: AbortSignal }) => {
			calls.push(args);
			if (args[0] === "tab" && args[1] === "create")
				return response({ result: { root_pane: { pane_id: "w1:p9" }, tab: { tab_id: "w1:t9" } } });
			if (args[0] === "pane" && args[1] === "wait-output")
				return new Promise((_resolve, reject) => {
					// 真实 pi.exec 对已中止的 signal 立即拒绝；mock 必须同样处理，否则永远等不到 abort 事件。
					if (options.signal?.aborted) return reject(new Error("start aborted"));
					options.signal?.addEventListener("abort", () => reject(new Error("start aborted")), { once: true });
				});
			if (args[0] === "agent" && args[1] === "get") return missingAgent();
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	const ctx = { cwd: "/tmp", model: { provider: "p", id: "m" }, thinkingLevel: "medium" } as never;
	const starting = pool.start(ctx, { name: "hang", model: "p/m", thinking: "medium", prompt: "做" });
	starting.catch(() => {});
	await new Promise((resolve) => setTimeout(resolve, 20));
	await pool.stop("hang", true);
	await expect(starting).rejects.toThrow();
	// 启动被中止：壳已清理、未启动 agent、状态没有孤儿复活。
	expect(calls).toContainEqual(["tab", "close", "w1:t9"]);
	expect(calls.some((args) => args[0] === "agent" && args[1] === "start")).toBe(false);
	expect(store.state.workers).toEqual([]);
	pool.shutdown();
});

test("a queued start can be stopped before it runs", async () => {
	process.env.SHELL = "/bin/zsh";
	const store = createStore();
	const calls: string[][] = [];
	// 首个启动悬在 tab 创建（串行分配临界区内），第二个启动因此真正排队。
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[], options: { signal?: AbortSignal }) => {
			calls.push(args);
			if (args[0] === "tab" && args[1] === "create")
				return new Promise((_resolve, reject) => {
					if (options.signal?.aborted) return reject(new Error("start aborted"));
					options.signal?.addEventListener("abort", () => reject(new Error("start aborted")), { once: true });
				});
			if (args[0] === "agent" && args[1] === "get") return missingAgent();
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	const ctx = { cwd: "/tmp", model: { provider: "p", id: "m" }, thinkingLevel: "medium" } as never;
	const first = pool.start(ctx, { name: "hang", model: "p/m", thinking: "medium", prompt: "做" });
	first.catch(() => {});
	const second = pool.start(ctx, { name: "queued", model: "p/m", thinking: "medium", prompt: "做" });
	second.catch(() => {});
	await new Promise((resolve) => setTimeout(resolve, 20));
	// 同批并行工具调用可达：排队中的启动必须能被 stop 命中，不报“Worker 不存在”。
	await pool.stop("queued", true);
	await pool.stop("hang", true);
	await expect(first).rejects.toThrow();
	await expect(second).rejects.toThrow("排队阶段已被停止");
	// 排队启动被取消：只有首个启动尝试过建 shell，状态无残留。
	expect(calls.filter((args) => args[0] === "tab" && args[1] === "create").length).toBe(1);
	expect(store.state.workers).toEqual([]);
	pool.shutdown();
});

test("a renamed dormant resume can be stopped by its old pool identity", async () => {
	process.env.SHELL = "/bin/zsh";
	const store = createStore();
	store.dispatch({
		type: "UPSERT_WORKER",
		worker: { name: "worker-1", model: "p/m", thinking: "medium" as const, status: "dormant" as const, sessionPath: "/tmp/worker.jsonl" },
	});
	const calls: string[][] = [];
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[], options: { signal?: AbortSignal }) => {
			calls.push(args);
			if (args[0] === "tab" && args[1] === "create")
				return response({ result: { root_pane: { pane_id: "w1:p9" }, tab: { tab_id: "w1:t9" } } });
			if (args[0] === "pane" && args[1] === "wait-output")
				return new Promise((_resolve, reject) => {
					if (options.signal?.aborted) return reject(new Error("start aborted"));
					options.signal?.addEventListener("abort", () => reject(new Error("start aborted")), { once: true });
				});
			if (args[0] === "agent" && args[1] === "get") return missingAgent();
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	const ctx = { cwd: "/tmp", model: { provider: "p", id: "m" }, thinkingLevel: "medium" } as never;
	// 改名恢复：工人池展示的仍是旧名，按旧身份 stop 必须命中同一取消控制器。
	const resume = pool.start(ctx, { name: "renamed", session: "worker-1", prompt: "继续" });
	resume.catch(() => {});
	await new Promise((resolve) => setTimeout(resolve, 20));
	await pool.stop("worker-1", true);
	await expect(resume).rejects.toThrow();
	// 被显式停掉的启动不得以任何身份复活：既无 renamed，也不恢复旧休眠引用。
	expect(store.state.workers).toEqual([]);
	expect(calls.some((args) => args[0] === "agent" && args[1] === "start")).toBe(false);
	pool.shutdown();
});

test("default stop of an in-flight renamed resume keeps the dormant reference", async () => {
	process.env.SHELL = "/bin/zsh";
	const store = createStore();
	const dormantRef = { name: "worker-1", model: "p/m", thinking: "medium" as const, status: "dormant" as const, sessionPath: "/tmp/worker.jsonl" };
	store.dispatch({ type: "UPSERT_WORKER", worker: dormantRef });
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[], options: { signal?: AbortSignal }) => {
			if (args[0] === "tab" && args[1] === "create")
				return response({ result: { root_pane: { pane_id: "w1:p9" }, tab: { tab_id: "w1:t9" } } });
			if (args[0] === "pane" && args[1] === "wait-output")
				return new Promise((_resolve, reject) => {
					if (options.signal?.aborted) return reject(new Error("start aborted"));
					options.signal?.addEventListener("abort", () => reject(new Error("start aborted")), { once: true });
				});
			if (args[0] === "agent" && args[1] === "get") return missingAgent();
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	const ctx = { cwd: "/tmp", model: { provider: "p", id: "m" }, thinkingLevel: "medium" } as never;
	const resume = pool.start(ctx, { name: "renamed", session: "worker-1", prompt: "继续" });
	resume.catch(() => {});
	await new Promise((resolve) => setTimeout(resolve, 20));
	// 默认 stop（非 forget）：中止启动，但必须保留可恢复的休眠引用——只有 forget 才删。
	await pool.stop("worker-1", false);
	await expect(resume).rejects.toThrow();
	expect(store.state.workers).toEqual([dormantRef]);
	pool.shutdown();
});

test("workers launch in parallel once layout allocation hands off", async () => {
	process.env.SHELL = "/bin/zsh";
	const store = createStore();
	const paneTabs = new Map<string, string>();
	const calls: string[][] = [];
	let paneSerial = 0;
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[], options: { signal?: AbortSignal }) => {
			calls.push(args);
			if (args[0] === "tab" && args[1] === "create") {
				const paneId = `w1:p${++paneSerial}`;
				paneTabs.set(paneId, "w1:t1");
				return response({ result: { root_pane: { pane_id: paneId }, tab: { tab_id: "w1:t1" } } });
			}
			if (args[0] === "pane" && args[1] === "split") {
				const paneId = `w1:p${++paneSerial}`;
				paneTabs.set(paneId, "w1:t1");
				return response({ result: { pane: { pane_id: paneId } } });
			}
			if (args[0] === "pane" && args[1] === "wait-output") {
				// 首个工人的 shell 握手永久悬挂；后续工人立即就绪。
				if (args[2] === "w1:p1")
					return new Promise((_resolve, reject) => {
						if (options.signal?.aborted) return reject(new Error("start aborted"));
						options.signal?.addEventListener("abort", () => reject(new Error("start aborted")), { once: true });
					});
				return response({});
			}
			if (args[0] === "agent" && args[1] === "start") {
				const paneId = args[args.indexOf("--pane") + 1] as string;
				return agentResponse(paneId, paneTabs.get(paneId) as string, `/tmp/${args[2]}.jsonl`);
			}
			if (args[0] === "agent" && args[1] === "prompt")
				return new Promise((resolve) => {
					if (options.signal?.aborted) return resolve(response({}));
					options.signal?.addEventListener("abort", () => resolve(response({})), { once: true });
				});
			if (args[0] === "agent" && args[1] === "get") return missingAgent();
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	const ctx = { cwd: "/tmp", model: { provider: "p", id: "m" }, thinkingLevel: "medium" } as never;
	const slow = pool.start(ctx, { name: "slow", model: "p/m", thinking: "medium", prompt: "做" });
	slow.catch(() => {});
	const fast = pool.start(ctx, { name: "fast", model: "p/m", thinking: "medium", prompt: "做" });
	// 并行启动：首个工人还在 shell 握手，后续工人已完成启动——不被全局串行化堵住。
	const started = await fast;
	expect(started.status).toBe("working");
	expect(store.state.workers.find((worker) => worker.name === "slow")?.status).toBe("starting");
	await pool.stop("slow", true);
	await expect(slow).rejects.toThrow();
	// 首工人开的 tab 已被后续工人共享：中止首工人只收它自己的 pane，不能连坐关整 tab。
	expect(calls.some((args) => args[0] === "tab" && args[1] === "close")).toBe(false);
	expect(calls).toContainEqual(["pane", "close", "w1:p1"]);
	expect(store.state.workers.find((worker) => worker.name === "fast")?.status).toBe("working");
	pool.shutdown();
});

test("reload shutdown waits out in-flight starts and leaves state and shells untouched", async () => {
	process.env.SHELL = "/bin/zsh";
	const store = createStore();
	store.dispatch({
		type: "UPSERT_WORKER",
		worker: { name: "worker-1", model: "p/m", thinking: "medium" as const, status: "dormant" as const, sessionPath: "/tmp/worker.jsonl" },
	});
	const calls: string[][] = [];
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[], options: { signal?: AbortSignal }) => {
			calls.push(args);
			if (args[0] === "tab" && args[1] === "create")
				return response({ result: { root_pane: { pane_id: "w1:p9" }, tab: { tab_id: "w1:t9" } } });
			if (args[0] === "pane" && args[1] === "wait-output")
				return new Promise((_resolve, reject) => {
					if (options.signal?.aborted) return reject(new Error("start aborted"));
					options.signal?.addEventListener("abort", () => reject(new Error("start aborted")), { once: true });
				});
			if (args[0] === "agent" && args[1] === "get") return missingAgent();
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	const ctx = { cwd: "/tmp", model: { provider: "p", id: "m" }, thinkingLevel: "medium" } as never;
	const resume = pool.start(ctx, { session: "/tmp/worker.jsonl", model: "p/m", thinking: "medium", prompt: "继续" });
	resume.catch(() => {});
	await new Promise((resolve) => setTimeout(resolve, 20));
	// reload 路径：shutdown 必须等在飞启动退出，且不关 shell、不改状态——现场留给下个运行时 reconcile。
	await pool.shutdown();
	await expect(resume).rejects.toThrow();
	expect(calls.some((args) => args[1] === "close")).toBe(false);
	expect(store.state.workers.map((worker) => worker.name)).toEqual(["worker-1"]);
	expect(store.state.workers[0]?.status).toBe("starting");
});

test("a duplicate same-name start is rejected at enqueue instead of queueing uncancellable", async () => {
	process.env.SHELL = "/bin/zsh";
	const store = createStore();
	const calls: string[][] = [];
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[], options: { signal?: AbortSignal }) => {
			calls.push(args);
			if (args[0] === "tab" && args[1] === "create")
				return response({ result: { root_pane: { pane_id: "w1:p9" }, tab: { tab_id: "w1:t9" } } });
			if (args[0] === "pane" && args[1] === "wait-output")
				return new Promise((_resolve, reject) => {
					// 真实 pi.exec 对已中止的 signal 立即拒绝；mock 必须同样处理，否则永远等不到 abort 事件。
					if (options.signal?.aborted) return reject(new Error("start aborted"));
					options.signal?.addEventListener("abort", () => reject(new Error("start aborted")), { once: true });
				});
			if (args[0] === "agent" && args[1] === "get") return missingAgent();
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	const ctx = { cwd: "/tmp", model: { provider: "p", id: "m" }, thinkingLevel: "medium" } as never;
	const first = pool.start(ctx, { name: "dup", model: "p/m", thinking: "medium", prompt: "做" });
	first.catch(() => {});
	// 同名并发启动：第二个入队即拒，不会成为 stop 杀不掉的漏网之鱼。
	await expect(pool.start(ctx, { name: "dup", model: "p/m", thinking: "medium", prompt: "再做" })).rejects.toThrow("不能重复启动");
	// 等第一个启动真正建出 shell 再停：断言的是"建出来后能收干净"，不靠微任务时序踩点。
	while (!calls.some((args) => args[0] === "tab" && args[1] === "create"))
		await new Promise((resolve) => setTimeout(resolve, 5));
	await pool.stop("dup", true);
	await expect(first).rejects.toThrow();
	expect(calls.filter((args) => args[0] === "tab" && args[1] === "create").length).toBe(1);
	expect(store.state.workers).toEqual([]);
	pool.shutdown();
});

test("a queued dormant resume can be stopped through the dormant branch", async () => {
	process.env.SHELL = "/bin/zsh";
	const store = createStore();
	store.dispatch({
		type: "UPSERT_WORKER",
		worker: { name: "worker-1", model: "p/m", thinking: "medium" as const, status: "dormant" as const, sessionPath: "/tmp/worker.jsonl" },
	});
	const calls: string[][] = [];
	// 首个启动悬在 tab 创建（串行分配临界区内），恢复请求因此真正排队。
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[], options: { signal?: AbortSignal }) => {
			calls.push(args);
			if (args[0] === "tab" && args[1] === "create")
				return new Promise((_resolve, reject) => {
					if (options.signal?.aborted) return reject(new Error("start aborted"));
					options.signal?.addEventListener("abort", () => reject(new Error("start aborted")), { once: true });
				});
			if (args[0] === "agent" && args[1] === "get") return missingAgent();
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	const ctx = { cwd: "/tmp", model: { provider: "p", id: "m" }, thinkingLevel: "medium" } as never;
	const first = pool.start(ctx, { name: "hang", model: "p/m", thinking: "medium", prompt: "做" });
	first.catch(() => {});
	// 仅凭 session 恢复休眠工人：入队时必须从引用反查出名字并登记取消控制器。
	const resume = pool.start(ctx, { session: "/tmp/worker.jsonl", model: "p/m", thinking: "medium", prompt: "继续" });
	resume.catch(() => {});
	await new Promise((resolve) => setTimeout(resolve, 20));
	// stop 走休眠分支：也必须中止排队中的恢复，不能只处理状态。
	await pool.stop("worker-1", true);
	await pool.stop("hang", true);
	await expect(first).rejects.toThrow();
	await expect(resume).rejects.toThrow("排队阶段已被停止");
	expect(calls.filter((args) => args[0] === "tab" && args[1] === "create").length).toBe(1);
	expect(store.state.workers).toEqual([]);
	pool.shutdown();
});

test("a stalled prompt still tracks a review that started without the occupancy signal", async () => {
	const directory = await mkdtemp(join(tmpdir(), "firecode-worker-stall-review-"));
	const sessionPath = join(directory, "worker.jsonl");
	const inProgress = await readFile(join(import.meta.dir, "fixtures/review-outcomes/in-progress.jsonl"), "utf8");
	const passed = await readFile(join(import.meta.dir, "fixtures/review-outcomes/passed.jsonl"), "utf8");
	await writeFile(sessionPath, '{"type":"session","version":3,"id":"worker"}\n');
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: { ...worker("idle"), sessionPath } });
	let waits = 0;
	let resolveNotice!: (value: string) => void;
	const notice = new Promise<string>((resolve) => { resolveNotice = resolve; });
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[]) => {
			if (args[0] === "agent" && args[1] === "prompt") {
				// 占用信号失效：审查已启动（checkpoint 落盘）但状态全程无变化，prompt --wait 报 stalled。
				await writeFile(sessionPath, inProgress);
				return { code: 1, stdout: "", stderr: "agent_prompt_stalled", killed: false };
			}
			if (args[0] === "agent" && args[1] === "wait") {
				waits += 1;
				if (waits === 2) {
					await writeFile(sessionPath, `${passed}${JSON.stringify({
						id: "assistant-1",
						message: { role: "assistant", content: [{ type: "text", text: "完成" }], stopReason: "stop" },
					})}\n`);
					return liveAgent("done", sessionPath);
				}
				return liveAgent("idle", sessionPath);
			}
			if (args[0] === "agent" && args[1] === "get") return liveAgent(undefined, sessionPath);
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster: resolveNotice,
	});
	await pool.review("worker-1");
	// stall 回退：runId 已推进，必须进入 reviewing 而不是误报审查未启动。
	expect(store.state.workers[0]?.status).toBe("reviewing");
	// 第一次 wait 观测到 idle 但 outcome 仍是 in_progress：不结算，退避后重挂直到终态。
	const text = await notice;
	expect(text).toContain("审查结束：通过");
	expect(waits).toBe(2);
	expect(store.state.workers[0]?.status).toBe("idle");
	await rm(directory, { recursive: true, force: true });
}, 15_000);

test("review initiation failure leaves the idle Worker available", async () => {
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: worker("idle") });
	const notices: string[] = [];
	const pool = new HerdrWorkers({
		pi: { exec: async () => ({ code: 1, stdout: "", stderr: "prompt rejected", killed: false }) } as never,
		store,
		workspaceId: "w1",
		notifyMaster: (notice) => notices.push(notice),
	});
	await expect(pool.review("worker-1")).rejects.toThrow("prompt rejected");
	expect(store.state.workers[0]?.status).toBe("idle");
	expect(notices).toEqual([]);
});

test("reload restores filtered review listening and reports connection failure", async () => {
	const fixture = join(import.meta.dir, "fixtures/review-outcomes/passed.jsonl");
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: { ...worker("reviewing"), sessionPath: fixture } });
	const calls: string[][] = [];
	let waitCalls = 0;
	let resolveResult!: (value: string) => void;
	const result = new Promise<string>((resolve) => { resolveResult = resolve; });
	const notices: string[] = [];
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[]) => {
			calls.push(args);
			if (args[0] === "agent" && args[1] === "get") return liveAgent(undefined, fixture);
			if (args[0] === "agent" && args[1] === "wait") {
				waitCalls += 1;
				return waitCalls === 1
					? { code: 1, stdout: "", stderr: "connection lost", killed: false }
					: liveAgent("idle", fixture);
			}
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster: (notice) => {
			notices.push(notice);
			if (notice.includes("审查结束")) resolveResult(notice);
		},
	});
	await pool.resume();
	expect(await result).toContain("审查结束：通过");
	expect(notices[0]).toContain("审查监听失败，正在恢复");
	expect(calls.filter((args) => args[0] === "agent" && args[1] === "wait")).toEqual([
		["agent", "wait", "w1:p2", "--until", "idle", "--until", "done"],
		["agent", "wait", "w1:p2", "--until", "idle", "--until", "done"],
	]);
	expect(store.state.workers[0]?.status).toBe("idle");
});

test("reload retains the review run snapshot and rejects an unchanged old terminal", async () => {
	const fixture = join(import.meta.dir, "fixtures/review-outcomes/passed.jsonl");
	const store = createStore();
	store.dispatch({
		type: "UPSERT_WORKER",
		worker: {
			...worker("reviewing"),
			sessionPath: fixture,
			reviewPreviousRunId: "passed-run",
		},
	});
	let resolveNotice!: (value: string) => void;
	const notice = new Promise<string>((resolve) => { resolveNotice = resolve; });
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[]) => {
			if (args[0] === "agent" && args[1] === "get") return liveAgent(undefined, fixture);
			if (args[0] === "agent" && args[1] === "wait") return liveAgent("idle", fixture);
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster: resolveNotice,
	});
	await pool.resume();
	expect(await notice).toContain("审查未启动");
	expect(store.state.workers[0]?.reviewPreviousRunId).toBeUndefined();
});

test("a blocked Worker remains blocked and asks the Master for input", async () => {
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: worker() });
	let resolveNotice!: (value: string) => void;
	const notice = new Promise<string>((resolve) => { resolveNotice = resolve; });
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[]) => {
			if (args[0] === "agent" && args[1] === "wait")
				return liveAgent("blocked", "/tmp/worker.jsonl", { "herdr:pi": "Allow edit to protected file?" });
			if (args[0] === "agent" && args[1] === "get") return liveAgent();
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster: resolveNotice,
	});
	await pool.resume();
	expect(await notice).toContain("Allow edit to protected file?");
	expect(store.state.workers[0]?.status).toBe("blocked");
});

test("non-success assistant stops are returned as failures", async () => {
	for (const sample of [
		{ stopReason: "error", errorMessage: "429 quota exhausted", expected: "429 quota exhausted" },
		{ stopReason: "length", text: "truncated", expected: "停止原因：length" },
	]) {
		const directory = await mkdtemp(join(tmpdir(), "firecode-worker-failure-"));
		const sessionPath = join(directory, "worker.jsonl");
		await writeFile(sessionPath, JSON.stringify({
			type: "message",
			id: "a1",
			parentId: null,
			message: {
				role: "assistant",
				content: sample.text ? [{ type: "text", text: sample.text }] : [],
				stopReason: sample.stopReason,
				...(sample.errorMessage ? { errorMessage: sample.errorMessage } : {}),
			},
		}) + "\n");
		const store = createStore();
		store.dispatch({ type: "UPSERT_WORKER", worker: { ...worker(), sessionPath } });
		let resolveNotice!: (value: string) => void;
		const notice = new Promise<string>((resolve) => { resolveNotice = resolve; });
		const pool = new HerdrWorkers({
			pi: { exec: async (_command: string, args: string[]) => {
				if (args[0] === "agent" && args[1] === "wait") return liveAgent("idle", sessionPath);
				if (args[0] === "agent" && args[1] === "get") return liveAgent(undefined, sessionPath);
				return response({});
			} } as never,
			store,
			workspaceId: "w1",
			notifyMaster: resolveNotice,
		});
		await pool.resume();
		const text = await notice;
		expect(text).toContain(sample.expected);
		// 真实产文 → 紧凑行：标记词汇与产文共用 event-format 常量，改词两侧同步、此处当场红。
		expect(masterEventDetails([text]).titles[0]).toBe(
			`子代理 worker-1 执行失败 — 停止原因：${sample.stopReason}`,
		);
		await rm(directory, { recursive: true, force: true });
	}
});

test("外部中止按中断回传：意图保留、中断时刻入档、续监挂起", async () => {
	// 两种真实形态：pi 自身信号中止记 aborted；经其它层浮出的中止是 error + abort 字样（2026-08-16 实测）。
	for (const sample of [
		{ stopReason: "aborted", text: "partial" },
		{ stopReason: "error", errorMessage: "The operation was aborted." },
	]) {
		const directory = await mkdtemp(join(tmpdir(), "firecode-worker-interrupt-"));
		const sessionPath = join(directory, "worker.jsonl");
		await writeFile(sessionPath, JSON.stringify({
			type: "message",
			id: "a1",
			parentId: null,
			message: {
				role: "assistant",
				content: sample.text ? [{ type: "text", text: sample.text }] : [],
				stopReason: sample.stopReason,
				...(sample.errorMessage ? { errorMessage: sample.errorMessage } : {}),
			},
		}) + "\n");
		const store = createStore();
		store.dispatch({ type: "UPSERT_WORKER", worker: { ...worker(), sessionPath, reviewNeeded: true } });
		const calls: string[][] = [];
		let resolveNotice!: (value: string) => void;
		const notice = new Promise<string>((resolve) => { resolveNotice = resolve; });
		const pool = new HerdrWorkers({
			pi: { exec: async (_command: string, args: string[], options: { signal?: AbortSignal }) => {
				calls.push(args);
				// 续监的 --until working 等待在真实 herdr 里会挂住，直到接手或中止。
				if (args[0] === "agent" && args[1] === "wait" && args.includes("working"))
					return new Promise((_resolve, reject) => {
						options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
					});
				if (args[0] === "agent" && args[1] === "wait") return liveAgent("idle", sessionPath);
				if (args[0] === "agent" && args[1] === "get") return liveAgent(undefined, sessionPath);
				return response({});
			} } as never,
			store,
			workspaceId: "w1",
			notifyMaster: resolveNotice,
		});
		await pool.resume();
		const text = await notice;
		expect(text).toContain("被中断");
		expect(text).not.toContain(`子代理 worker-1 执行失败`);
		expect(text).toContain("审查意图保留");
		// 真实产文 → 紧凑行：有正文时预览取中断前输出首句，无正文退化纯标题。
		expect(masterEventDetails([text]).titles[0]).toBe(sample.text
			? "子代理 worker-1 被中断（回合被外部中止，非执行失败） — partial"
			: "子代理 worker-1 被中断（回合被外部中止，非执行失败）");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(store.state.workers[0]).toMatchObject({ status: "idle", reviewNeeded: true });
		expect(store.state.workers[0]?.interruptedAt).toBeGreaterThan(0);
		expect(calls.some((args) => args[1] === "wait" && args.includes("working"))).toBe(true);
		await pool.shutdown();
		await rm(directory, { recursive: true, force: true });
	}
});

test("interrupt 指令：发 esc、结算按指令中断文案回传，非 working 拒绝", async () => {
	const directory = await mkdtemp(join(tmpdir(), "firecode-deliberate-interrupt-"));
	const sessionPath = join(directory, "worker.jsonl");
	await writeFile(sessionPath, JSON.stringify({
		type: "message",
		id: "a1",
		parentId: null,
		message: { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "aborted" },
	}) + "\n");
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: { ...worker(), sessionPath } });
	const calls: string[][] = [];
	let releaseWait!: () => void;
	const waitGate = new Promise<void>((resolve) => { releaseWait = resolve; });
	let resolveNotice!: (value: string) => void;
	const notice = new Promise<string>((resolve) => { resolveNotice = resolve; });
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[], options: { signal?: AbortSignal }) => {
			calls.push(args);
			if (args[0] === "agent" && args[1] === "send-keys") {
				releaseWait();
				return response({});
			}
			// 中断后的续监（--until working）在真实 herdr 里会挂住。
			if (args[0] === "agent" && args[1] === "wait" && args.includes("working"))
				return new Promise((_resolve, reject) => {
					options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				});
			// 工作监听：esc 投递后才落定为 idle。
			if (args[0] === "agent" && args[1] === "wait")
				return waitGate.then(() => liveAgent("idle", sessionPath));
			if (args[0] === "agent" && args[1] === "get") return liveAgent(undefined, sessionPath);
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster: resolveNotice,
	});
	await pool.resume();
	await pool.interrupt("worker-1");
	expect(calls.some((args) => args[1] === "send-keys" && args.includes("esc"))).toBe(true);
	const text = await notice;
	expect(text).toContain("已按你的 interrupt 指令停下");
	expect(text).not.toContain("被外部中止");
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(store.state.workers[0]?.status).toBe("idle");
	expect(store.state.workers[0]?.interruptedAt).toBeGreaterThan(0);
	// 护栏：已经停下的子代理不可再中断。
	await expect(pool.interrupt("worker-1")).rejects.toThrow("只有 working 子代理可以中断");
	await pool.shutdown();
	await rm(directory, { recursive: true, force: true });
});

test("reload 后过期的中断计时立即触发自动续跑提醒，中断态保留到接手", async () => {
	const store = createStore();
	store.dispatch({
		type: "UPSERT_WORKER",
		worker: { ...worker("idle"), interruptedAt: Date.now() - 400_000 },
	});
	let resolveNotice!: (value: string) => void;
	const notice = new Promise<string>((resolve) => { resolveNotice = resolve; });
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[], options: { signal?: AbortSignal }) => {
			if (args[0] === "agent" && args[1] === "wait")
				return new Promise((_resolve, reject) => {
					options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				});
			if (args[0] === "agent" && args[1] === "get") return liveAgent("idle");
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster: resolveNotice,
	});
	await pool.resume();
	const text = await notice;
	expect(text).toContain("中断后已 5 分钟无动静");
	expect(text).toContain("无需与用户确认");
	// 中断时刻不随提醒消耗：它是中断态唯一标记，审查票的 send 门禁豁免凭它识别。
	expect(store.state.workers[0]?.interruptedAt).toBeGreaterThan(0);
	expect(store.state.workers[0]?.status).toBe("idle");
	await pool.shutdown();
});

test("中断的审查票可直接 send 续跑：门禁放行、中断态消耗、审查意图保留", async () => {
	const store = createStore();
	store.dispatch({
		type: "UPSERT_WORKER",
		worker: { ...worker("idle"), reviewNeeded: true, interruptedAt: Date.now() - 400_000 },
	});
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[], options: { signal?: AbortSignal }) => {
			if (args[0] === "agent" && (args[1] === "wait" || args[1] === "prompt"))
				return new Promise((_resolve, reject) => {
					options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				});
			if (args[0] === "agent" && args[1] === "get") return liveAgent("idle");
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	await pool.resume();
	// 自动续跑指引的动作必须真实可执行：审查票在中断态不是投递窗口，send 不得拒绝。
	await pool.send("worker-1", "继续刚才被中断的工作");
	expect(store.state.workers[0]).toMatchObject({ status: "working", reviewNeeded: true });
	expect(store.state.workers[0]?.interruptedAt).toBeUndefined();
	await pool.shutdown();
});

test("send 可声明审查票：轻重之分跟任务走，追加的重活与 start 委派同权自动补审", async () => {
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: worker("idle") });
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[], options: { signal?: AbortSignal }) => {
			if (args[0] === "agent" && (args[1] === "wait" || args[1] === "prompt"))
				return new Promise((_resolve, reject) => {
					options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				});
			if (args[0] === "agent" && args[1] === "get") return liveAgent("idle");
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	await pool.resume();
	await pool.send("worker-1", "追加一个重要实现任务", true);
	// 意图入档后与 start 声明的审查票同一条自动补审路径（落定→autoReview 已有覆盖）。
	expect(store.state.workers[0]).toMatchObject({ status: "working", reviewNeeded: true });
	await pool.shutdown();
});

test("Dormant 恢复与新建同布局：有同伴时 split 进 workers tab 而非新开 tab", async () => {
	process.env.SHELL = "/bin/zsh";
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: worker("idle") });
	store.dispatch({ type: "UPSERT_WORKER", worker: {
		name: "resume-me", model: "p/m", thinking: "medium" as const,
		status: "dormant" as const, sessionPath: "/tmp/resume.jsonl",
	} });
	const calls: string[][] = [];
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[], options: { signal?: AbortSignal }) => {
			calls.push(args);
			if (args[0] === "pane" && args[1] === "split")
				return response({ result: { pane: { pane_id: "w1:p9" } } });
			if (args[0] === "pane" && args[1] === "wait-output")
				return new Promise((_resolve, reject) => {
					if (options.signal?.aborted) return reject(new Error("aborted"));
					options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				});
			if (args[0] === "agent" && args[1] === "get") return missingAgent();
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	const ctx = { cwd: "/tmp", model: { provider: "p", id: "m" }, thinkingLevel: "medium" } as never;
	const started = pool.start(ctx, { session: "resume-me", prompt: "继续" });
	started.catch(() => {});
	while (!calls.some((args) => args[0] === "pane" && args[1] === "split"))
		await new Promise((resolve) => setTimeout(resolve, 5));
	const split = calls.find((args) => args[0] === "pane" && args[1] === "split");
	// 目标是既有工人的 pane；恢复不再新开 tab（cwd 随 pane 各自携带）。
	expect(split?.[2]).toBe("w1:p2");
	expect(split).toContain("--cwd");
	expect(calls.some((args) => args[0] === "tab" && args[1] === "create")).toBe(false);
	await pool.stop("resume-me", true);
	await expect(started).rejects.toThrow();
	await pool.shutdown();
});

test("cwd 校验失败拒绝启动，合法 cwd 进 pane 与档案", async () => {
	process.env.SHELL = "/bin/zsh";
	const checkout = await mkdtemp(join(tmpdir(), "firecode-worker-cwd-"));
	const realCheckout = await realpath(checkout);
	const store = createStore();
	const calls: string[][] = [];
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[], options: { signal?: AbortSignal }) => {
			calls.push(args);
			if (args[0] === "tab" && args[1] === "create")
				return response({ result: { root_pane: { pane_id: "w1:p9" }, tab: { tab_id: "w1:t9" } } });
			if (args[0] === "pane" && args[1] === "wait-output")
				return new Promise((_resolve, reject) => {
					if (options.signal?.aborted) return reject(new Error("start aborted"));
					options.signal?.addEventListener("abort", () => reject(new Error("start aborted")), { once: true });
				});
			if (args[0] === "agent" && args[1] === "get") return missingAgent();
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	const ctx = { cwd: "/tmp", model: { provider: "p", id: "m" }, thinkingLevel: "medium" } as never;
	// 静默回退 Master 目录会让工人在错误 checkout 真实动手：校验失败必须拒绝。
	await expect(pool.start(ctx, { name: "cw", model: "p/m", thinking: "medium", prompt: "做", cwd: "relative/path" })).rejects.toThrow("绝对路径");
	await expect(pool.start(ctx, { name: "cw", model: "p/m", thinking: "medium", prompt: "做", cwd: "/nonexistent-firecode-cwd" })).rejects.toThrow("不存在");
	expect(store.state.workers).toEqual([]);
	const started = pool.start(ctx, { name: "cw", model: "p/m", thinking: "medium", prompt: "做", cwd: checkout });
	started.catch(() => {});
	while (!calls.some((args) => args[0] === "tab" && args[1] === "create"))
		await new Promise((resolve) => setTimeout(resolve, 5));
	const create = calls.find((args) => args[0] === "tab" && args[1] === "create");
	expect(create?.[create.indexOf("--cwd") + 1]).toBe(realCheckout);
	expect(store.state.workers[0]?.cwd).toBe(realCheckout);
	await pool.stop("cw", true);
	await expect(started).rejects.toThrow();
	await pool.shutdown();
	await rm(checkout, { recursive: true, force: true });
});

test("委派技能白名单：非 tdd 技能前缀（含拼错）在投递前被拒，tdd 放行", async () => {
	process.env.SHELL = "/bin/sh";
	const store = createStore();
	const pool = new HerdrWorkers({
		pi: { exec: async () => response({}) } as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	const ctx = { cwd: "/tmp", model: { provider: "p", id: "m" }, thinkingLevel: "medium" } as never;
	await expect(pool.start(ctx, { name: "a", model: "p/m", thinking: "medium", prompt: "/skill:implement 执行工单 #1" })).rejects.toThrow("只允许 /skill:tdd");
	await expect(pool.start(ctx, { name: "a", model: "p/m", thinking: "medium", prompt: "/skills:implement 拼错的前缀" })).rejects.toThrow("只允许 /skill:tdd");
	expect(store.state.workers).toEqual([]);
	// tdd 放行：穿过白名单到达 shell 阶段（非 zsh 环境报的是握手错误，不是白名单拒绝）。
	await expect(pool.start(ctx, { name: "a", model: "p/m", thinking: "medium", prompt: "/skill:tdd 按 spec 实现" })).rejects.toThrow("zsh");
	store.dispatch({ type: "UPSERT_WORKER", worker: worker("blocked") });
	await expect(pool.send("worker-1", "/skill:implement 继续")).rejects.toThrow("只允许 /skill:tdd");
	await pool.shutdown();
});

test("review 投递失败后中断续监重挂，监视与计时承诺不断线", async () => {
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: { ...worker("idle"), interruptedAt: Date.now() } });
	const calls: string[][] = [];
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[], options: { signal?: AbortSignal }) => {
			calls.push(args);
			if (args[0] === "agent" && args[1] === "prompt")
				return { code: 1, stdout: "", stderr: "prompt rejected", killed: false };
			if (args[0] === "agent" && args[1] === "wait")
				return new Promise((_resolve, reject) => {
					options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				});
			if (args[0] === "agent" && args[1] === "get") return liveAgent("idle");
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	await expect(pool.review("worker-1")).rejects.toThrow("失败");
	await new Promise((resolve) => setTimeout(resolve, 10));
	// 投递失败不能把中断态工人扔在无监视状态：续监重新挂上，中断时刻保留。
	expect(calls.some((args) => args[1] === "wait" && args.includes("working"))).toBe(true);
	expect(store.state.workers[0]).toMatchObject({ status: "idle" });
	expect(store.state.workers[0]?.interruptedAt).toBeGreaterThan(0);
	await pool.shutdown();
});

test("a failed Herdr wait reattaches and still returns the result", async () => {
	const directory = await mkdtemp(join(tmpdir(), "firecode-worker-reattach-"));
	const sessionPath = join(directory, "worker.jsonl");
	await writeFile(sessionPath, JSON.stringify({
		type: "message",
		id: "a1",
		parentId: null,
		message: { role: "assistant", content: [{ type: "text", text: "finished" }], stopReason: "stop" },
	}) + "\n");
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: { ...worker(), sessionPath } });
	let waitCalls = 0;
	let resolveResult!: (value: string) => void;
	const result = new Promise<string>((resolve) => { resolveResult = resolve; });
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[]) => {
			if (args[0] === "agent" && args[1] === "get") return liveAgent(undefined, sessionPath);
			if (args[0] === "agent" && args[1] === "wait") {
				waitCalls += 1;
				return waitCalls === 1
					? { code: 1, stdout: "", stderr: "connection lost", killed: false }
					: liveAgent("idle", sessionPath);
			}
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster: (notice) => { if (notice.includes("已停下")) resolveResult(notice); },
	});
	await pool.resume();
	expect(await result).toContain("finished");
	expect(waitCalls).toBe(2);
	expect(store.state.workers[0]?.status).toBe("idle");
	await rm(directory, { recursive: true, force: true });
});

test("external review occupancy is not a question: monitoring keeps waiting for the real settle", async () => {
	const directory = await mkdtemp(join(tmpdir(), "firecode-worker-selfreview-"));
	const sessionPath = join(directory, "worker.jsonl");
	await writeFile(sessionPath, JSON.stringify({
		type: "message",
		id: "a1",
		parentId: null,
		message: { role: "assistant", content: [{ type: "text", text: "交付完成" }], stopReason: "stop" },
	}) + "\n");
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: { ...worker(), sessionPath } });
	const waits: string[][] = [];
	let resolveResult!: (value: string) => void;
	const result = new Promise<string>((resolve) => { resolveResult = resolve; });
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[]) => {
			if (args[0] === "agent" && args[1] === "get") return liveAgent(undefined, sessionPath);
			if (args[0] === "agent" && args[1] === "wait") {
				waits.push(args);
				// 第一次结算：审查占用态——不是 Worker 提问，不得就此停止监听。
				if (waits.length === 1)
					return liveAgent("blocked", sessionPath, { review: "对抗审查进行中" });
				// 审查落终态后才真正 idle：写入 2 轮通过的终态 checkpoint。
				await appendFile(sessionPath, JSON.stringify(terminalReviewCheckpoint()) + "\n");
				return liveAgent("idle", sessionPath);
			}
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster: (notice) => { if (notice.includes("已停下")) resolveResult(notice); },
	});
	await pool.resume();
	const text = await result;
	// 外部审查的终态不再由工作结算读取；工作结算只回传交付本身。
	expect(text).toContain("交付完成");
	// 占用态之后的等待必须跳过 blocked，直到审查落终态。
	expect(waits[1]).toContain("--until");
	expect(waits[1]).toContain("idle");
	expect(store.state.workers[0]?.status).toBe("idle");
	await rm(directory, { recursive: true, force: true });
});

test("review-flagged worker settles, auto-review fires and relays the verdict", async () => {
	const directory = await mkdtemp(join(tmpdir(), "firecode-worker-autoreview-"));
	const sessionPath = join(directory, "worker.jsonl");
	await writeFile(sessionPath, JSON.stringify({
		type: "message",
		id: "a1",
		parentId: null,
		message: { role: "assistant", content: [{ type: "text", text: "实现完成" }], stopReason: "stop" },
	}) + "\n");
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: { ...worker("working"), sessionPath, reviewNeeded: true } });
	const notices: string[] = [];
	let resolveVerdict!: (value: string) => void;
	const verdict = new Promise<string>((resolve) => { resolveVerdict = resolve; });
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[]) => {
			if (args[0] === "agent" && args[1] === "get") return liveAgent(undefined, sessionPath);
			if (args[0] === "agent" && args[1] === "prompt" && args.includes("/fire-review")) {
				// 自动补审投递：审查启动后写入终态 checkpoint。
				await appendFile(sessionPath, JSON.stringify(terminalReviewCheckpoint()) + "\n");
				return liveAgent("blocked", sessionPath, { review: "对抗审查进行中" });
			}
			if (args[0] === "agent" && args[1] === "prompt") return liveAgent("idle", sessionPath);
			if (args[0] === "agent" && args[1] === "wait") return liveAgent("idle", sessionPath);
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster: (notice) => {
			notices.push(notice);
			if (notice.includes("审查结束")) resolveVerdict(notice);
		},
	});
	await pool.resume();
	const text = await verdict;
	// 结果与审查终态两条回传：先「已自动发起」，再「审查结束：通过（2 轮）」。
	expect(notices.some((notice) => notice.includes("将自动发起对抗审查"))).toBe(true);
	expect(text).toContain("审查结束：通过（2 轮）");
	// 真实产文 → 紧凑行：日常最高频的两条路径（已停下/审查结束）同样锁到共享常量。
	expect(masterEventDetails([notices[0] ?? ""]).titles[0]).toBe("子代理 worker-1 已停下 — 实现完成");
	expect(masterEventDetails([text]).titles[0]).toBe("子代理 worker-1 审查结束：通过（2 轮） — 实现完成");
	// 审查意图一次性消耗：档案里不再带 reviewNeeded。
	expect(store.state.workers[0]?.reviewNeeded).toBeUndefined();
	expect(store.state.workers[0]?.status).toBe("idle");
	await rm(directory, { recursive: true, force: true });
});

test("auto-review delivery failure keeps the intent for retry", async () => {
	const directory = await mkdtemp(join(tmpdir(), "firecode-worker-autoreview-fail-"));
	const sessionPath = join(directory, "worker.jsonl");
	await writeFile(sessionPath, JSON.stringify({
		type: "message",
		id: "a1",
		parentId: null,
		message: { role: "assistant", content: [{ type: "text", text: "实现完成" }], stopReason: "stop" },
	}) + "\n");
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: { ...worker("idle"), sessionPath, reviewNeeded: true } });
	let resolveFailure!: (value: string) => void;
	const failure = new Promise<string>((resolve) => { resolveFailure = resolve; });
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[]) => {
			if (args[0] === "agent" && args[1] === "get") return liveAgent(undefined, sessionPath);
			if (args[0] === "agent" && args[1] === "prompt" && args.includes("/fire-review"))
				return { code: 1, stdout: "", stderr: "herdr unavailable", killed: false };
			if (args[0] === "agent" && (args[1] === "prompt" || args[1] === "wait")) return liveAgent("idle", sessionPath);
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster: (notice) => { if (notice.includes("自动审查发起失败")) resolveFailure(notice); },
	});
	await pool.send("worker-1", "按 01 工单实现").catch(() => {});
	// send 守卫会拒绝审查票：直接用工作监听路径触发结算。
	store.dispatch({ type: "UPSERT_WORKER", worker: { ...worker("working"), sessionPath, reviewNeeded: true } });
	await pool.resume();
	const text = await failure;
	expect(text).toContain("意图保留");
	// 意图未消耗：档案仍带 reviewNeeded，reload/手动 review 可重试。
	expect(store.state.workers[0]?.reviewNeeded).toBe(true);
	await rm(directory, { recursive: true, force: true });
});

test("send is rejected while a review ticket awaits its automatic review", async () => {
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: { ...worker("idle"), reviewNeeded: true } });
	const pool = new HerdrWorkers({
		pi: { exec: async () => response({}) } as never,
		store,
		workspaceId: "w1",
		notifyMaster: () => {},
	});
	await expect(pool.send("worker-1", "追问")).rejects.toThrow("待自动审查");
});

test("stop during review delivery cannot revive the dormant Worker", async () => {
	const directory = await mkdtemp(join(tmpdir(), "firecode-worker-stop-review-"));
	const sessionPath = join(directory, "worker.jsonl");
	await writeFile(sessionPath, "");
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: { ...worker("idle"), sessionPath } });
	let pool!: HerdrWorkers;
	pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[]) => {
			if (args[0] === "agent" && args[1] === "get") return liveAgent(undefined, sessionPath);
			if (args[0] === "agent" && args[1] === "prompt" && args.includes("/fire-review")) {
				// 投递等待期间 Worker 被停止；投递随后"成功"返回。
				await pool.stop("worker-1", false);
				return liveAgent("blocked", sessionPath, { review: "对抗审查进行中" });
			}
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster: () => {},
	});
	await pool.review("worker-1").catch(() => {});
	// 迟到的投递返回不得把已休眠的 Worker 写回 reviewing。
	expect(store.state.workers[0]?.status).toBe("dormant");
});

function terminalReviewCheckpoint() {
	const reviewers = (status: "passed" | "failed") => [
		{ index: 0, model: "p/sol", thinking: "high", status, summary: "s", details: "d" },
	];
	return {
		type: "custom",
		customType: "firecode-review-checkpoint",
		data: {
			version: 5,
			seq: 9,
			runId: "run-self-1",
			phase: "settled",
			round: 2,
			focus: "",
			history: [
				{ round: 1, result: "failed", details: "d", reviewers: reviewers("failed"), elapsedMs: 1 },
				{ round: 2, result: "passed", details: "d", reviewers: reviewers("passed"), elapsedMs: 1 },
			],
			active: null,
			pending: null,
			repair: null,
			summary: null,
			consecutiveFailures: 1,
			startedAt: 1,
			roundStartedAt: 2,
			updatedAt: 3,
		},
	};
}

test("done keeps the Worker live for Master follow-up", async () => {
	const directory = await mkdtemp(join(tmpdir(), "firecode-worker-done-"));
	const sessionPath = join(directory, "worker.jsonl");
	await writeFile(sessionPath, JSON.stringify({
		type: "message",
		id: "a1",
		parentId: null,
		message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
	}) + "\n");
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: { ...worker(), sessionPath } });
	const calls: string[][] = [];
	let resolveNotice!: (value: string) => void;
	const notice = new Promise<string>((resolve) => { resolveNotice = resolve; });
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[]) => {
			calls.push(args);
			if (args[0] === "agent" && args[1] === "wait") return liveAgent("done", sessionPath);
			if (args[0] === "agent" && args[1] === "get") return liveAgent(undefined, sessionPath);
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster: resolveNotice,
	});
	await pool.resume();
	expect(await notice).toContain("done");
	expect(store.state.workers[0]?.status).toBe("idle");
	expect(calls.some((args) => args[0] === "tab" && args[1] === "close")).toBe(false);
	await rm(directory, { recursive: true, force: true });
});

test("a late settlement cannot revive a stopped Worker", async () => {
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: worker() });
	let getCalls = 0;
	let releaseLatest!: () => void;
	let markLatestStarted!: () => void;
	const latestStarted = new Promise<void>((resolve) => { markLatestStarted = resolve; });
	const latest = new Promise<ReturnType<typeof response>>((resolve) => {
		releaseLatest = () => resolve(liveAgent());
	});
	const pool = new HerdrWorkers({
		pi: { exec: async (_command: string, args: string[]) => {
			if (args[0] === "agent" && args[1] === "wait") return liveAgent("idle");
			if (args[0] === "agent" && args[1] === "get") {
				getCalls += 1;
				if (getCalls === 2) {
					markLatestStarted();
					return latest;
				}
				return liveAgent();
			}
			return response({});
		} } as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	await pool.resume();
	await latestStarted;
	await pool.stop("worker-1");
	releaseLatest();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(store.state.workers[0]?.status).toBe("dormant");
});

test("stop releases the tab but keeps or forgets the session by choice", async () => {
	const store = createStore();
	store.dispatch({ type: "UPSERT_WORKER", worker: worker("idle") });
	const calls: string[][] = [];
	const pool = new HerdrWorkers({
		pi: {
			exec: async (_command: string, args: string[]) => {
				calls.push(args);
				return args[0] === "agent" && args[1] === "get" ? liveAgent() : response({});
			},
		} as never,
		store,
		workspaceId: "w1",
		notifyMaster() {},
	});
	await pool.stop("worker-1");
	expect(store.state.workers[0]?.status).toBe("dormant");
	expect(calls.some((args) => args[0] === "tab" && args[1] === "close")).toBe(true);
	await pool.stop("worker-1", true);
	expect(store.state.workers).toEqual([]);
});

function agentResponse(paneId: string, tabId: string, sessionPath: string) {
	return response({
		result: {
			agent: {
				pane_id: paneId,
				tab_id: tabId,
				agent_session: { kind: "path", value: sessionPath },
			},
		},
	});
}

function liveAgent(
	status?: "idle" | "blocked" | "done",
	sessionPath = "/tmp/worker.jsonl",
	stateLabels?: Record<string, string>,
) {
	return response({
		result: {
			agent: {
				pane_id: "w1:p2",
				tab_id: "w1:t2",
				agent_session: { kind: "path", value: sessionPath },
				...(status ? { agent_status: status } : {}),
				...(stateLabels ? { state_labels: stateLabels } : {}),
			},
		},
	});
}
