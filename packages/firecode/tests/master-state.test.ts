import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MasterConfig, MasterModel } from "../config.js";
import { masterEventDetails } from "../master/event-format.js";
import {
	MasterStore,
	initialMasterState,
	loadMasterState,
	reduceMaster,
	restoreMasterState,
} from "../master/state.js";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader.ts";

const configModule = await loadFirecodeModule("config.js") as {
	parseMasterConfig(raw: Record<string, unknown>, problems: string[]): MasterConfig;
};
const { parseMasterConfig } = configModule;
afterAll(cleanupFirecodeModules);

test("master 节省略时不注入公开默认花名册", () => {
	const problems: string[] = [];
	expect(parseMasterConfig({}, problems).models).toEqual([]);
	expect(problems).toEqual([]);
});

test("master 节未知字段、模型重复与缺失 model 都报配置问题", () => {
	const problems: string[] = [];
	const parsed = parseMasterConfig(
		{
			typo: true,
			models: [
				{ model: "openai-codex/gpt-5.6-sol", extra: 1 },
				{ thinking: "nope" },
				{ model: "openai-codex/gpt-5.6-sol" },
			],
		},
		problems,
	);
	expect(parsed.models[0]).toEqual({
		model: "openai-codex/gpt-5.6-sol",
		thinking: "medium",
		use: "通用",
	});
	expect(problems).toEqual([
		"未知字段 master.typo",
		"未知字段 master.models[0].extra",
		"master.models[1].model 必须是非空字符串",
		"master.models[1].thinking 值无效",
		"master.models 模型不能重复",
	]);
});

test("紧凑行提取：标题+正文首句预览，无标记行退化纯标题", () => {
	// 标记词汇的事实源在 event-format（herdr 产文与提取共用同一常量），此处只锁提取规则本身；
	// 真实产文→提取的端到端断言见 master-herdr-recovery 的落定流用例。
	expect(masterEventDetails([
		"Worker t 已停下\n回复：\nPR #603 就绪。\n细节……",
		"Worker x 审查结束：通过（2 轮）\n最终回复：\n\n**现场已恢复**",
		"提醒：Worker x 的落定消息未处置\nsend 继续派活。",
	])).toEqual({
		version: 1,
		titles: [
			"Worker t 已停下 — PR #603 就绪。",
			"Worker x 审查结束：通过（2 轮） — **现场已恢复**",
			"提醒：Worker x 的落定消息未处置",
		],
	});
});

const dormant = {
	name: "worker-1",
	model: "openai-codex/gpt-5.6-sol",
	thinking: "medium" as const,
	status: "dormant" as const,
	sessionPath: "/tmp/worker.jsonl",
};

test("restore rejects malformed identities, duplicate Pi sessions and foreign versions", () => {
	expect(restoreMasterState({ version: 5, workers: [dormant] })).toBeUndefined();
	// 会话路径是派发时预分配的身份，任何状态都不得缺失。
	expect(restoreMasterState({
		version: 6,
		workers: [{ ...dormant, sessionPath: undefined, status: "working", paneId: "w1:p2", tabId: "w1:t2" }],
	})).toBeUndefined();
	expect(restoreMasterState({ version: 6, workers: [{ ...dormant, status: "closed" }] })).toBeUndefined();
	expect(restoreMasterState({ version: 6, workers: [{ ...dormant, thinking: "huge" }] })).toBeUndefined();
	expect(restoreMasterState({ version: 6, workers: [dormant, dormant] })).toBeUndefined();
	expect(restoreMasterState({
		version: 6,
		workers: [dormant, { ...dormant, name: "worker-2" }],
	})).toBeUndefined();
	expect(restoreMasterState({ version: 6, workers: [dormant] })).toEqual({ version: 6, workers: [dormant] });
	const blocked = { ...dormant, status: "blocked", paneId: "w1:p2", tabId: "w1:t2" };
	expect(restoreMasterState({ version: 6, workers: [blocked] })).toEqual({ version: 6, workers: [blocked] });
	const reviewing = { ...blocked, status: "reviewing" };
	expect(restoreMasterState({ version: 6, workers: [reviewing] })).toEqual({ version: 6, workers: [reviewing] });
});

test("cwd/interruptedAt/disposition 类型错误拒绝，合法值保留", () => {
	expect(restoreMasterState({ version: 6, workers: [{ ...dormant, cwd: "" }] })).toBeUndefined();
	expect(restoreMasterState({ version: 6, workers: [{ ...dormant, interruptedAt: -1 }] })).toBeUndefined();
	expect(restoreMasterState({ version: 6, workers: [{ ...dormant, disposition: "nagged" }] })).toBeUndefined();
	const interrupted = {
		...dormant,
		status: "idle",
		paneId: "w1:p2",
		tabId: "w1:t2",
		cwd: "/tmp/checkout",
		interruptedAt: 1700000000000,
		disposition: "pending",
	};
	expect(restoreMasterState({ version: 6, workers: [interrupted] })).toEqual({ version: 6, workers: [interrupted] });
});

test("Worker Pool state atomically overwrites one file instead of appending session entries", async () => {
	const directory = await mkdtemp(join(tmpdir(), "firecode-master-state-"));
	const path = join(directory, "state.json");
	const store = new MasterStore(path);
	for (let index = 1; index <= 20; index += 1) {
		store.dispatch({
			type: "UPSERT_WORKER",
			worker: { ...dormant, name: `worker-${index}`, sessionPath: `/tmp/worker-${index}.jsonl` },
		});
	}
	expect(await readdir(directory)).toEqual(["state.json"]);
	expect(JSON.parse(await readFile(path, "utf8")).workers).toHaveLength(20);
	expect(loadMasterState(path)?.workers).toHaveLength(20);
	store.dispatch({ type: "CLEAR" });
	expect(await readdir(directory)).toEqual([]);
	await rm(directory, { recursive: true, force: true });
});

test("store 变更后通知消费者，无变化的 dispatch 不通知", async () => {
	const directory = await mkdtemp(join(tmpdir(), "firecode-master-onchange-"));
	const path = join(directory, "state.json");
	let notified = 0;
	const store = new MasterStore(path, undefined, () => { notified += 1; });
	store.dispatch({ type: "UPSERT_WORKER", worker: dormant });
	expect(notified).toBe(1);
	// reducer 短路的无变化事件：不落盘、不通知。
	store.dispatch({ type: "REMOVE_WORKER", name: "no-such-worker" });
	expect(notified).toBe(1);
	store.dispatch({ type: "UPSERT_WORKER", worker: { ...dormant, status: "idle", paneId: "w1:p2", tabId: "w1:t2" } });
	expect(notified).toBe(2);
	await rm(directory, { recursive: true, force: true });
});

test("a corrupt current state fails closed instead of reviving an older snapshot", async () => {
	const directory = await mkdtemp(join(tmpdir(), "firecode-master-corrupt-"));
	const path = join(directory, "state.json");
	await writeFile(path, "not-json");
	expect(() => loadMasterState(path)).toThrow("不是合法 JSON");
	await rm(directory, { recursive: true, force: true });
});

test("旧版状态：只读调用方只拿到错误，状态所有者丢弃后从空池重建", async () => {
	const directory = await mkdtemp(join(tmpdir(), "firecode-master-legacy-"));
	const path = join(directory, "state.json");
	await writeFile(path, JSON.stringify({ version: 5, workers: [{ ...dormant, sessionPath: "/tmp/legacy.jsonl" }] }));
	// 只读旁路（bark 等）不得删文件：否则会抢先删掉 Master 的告知依据。
	expect(() => loadMasterState(path)).toThrow("旧版 v5");
	expect(() => loadMasterState(path)).toThrow("旧版 v5");
	// 不迁移也不永久阻断：所有者丢弃旧文件，从空池重建并落盘当前版本。
	const store = new MasterStore(path);
	expect(store.state.workers).toEqual([]);
	store.dispatch({ type: "UPSERT_WORKER", worker: dormant });
	expect(loadMasterState(path)?.workers).toHaveLength(1);
	await rm(directory, { recursive: true, force: true });
});

test("reducer records reviewing and removes forgotten Workers", () => {
	let state = reduceMaster(initialMasterState(), { type: "UPSERT_WORKER", worker: dormant });
	state = reduceMaster(state, {
		type: "UPSERT_WORKER",
		worker: { ...dormant, status: "reviewing", paneId: "w1:p2", tabId: "w1:t2" },
	});
	expect(state).toMatchObject({ version: 6, workers: [{ status: "reviewing" }] });
	state = reduceMaster(state, { type: "REMOVE_WORKER", name: "worker-1" });
	expect(state.workers).toEqual([]);
});
