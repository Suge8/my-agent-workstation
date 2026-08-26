import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LegacyMasterStateError,
	MasterStore,
	initialMasterState,
	loadMasterState,
	recoverMasterState,
	reduceMaster,
	restoreMasterState,
	type WorkerRef,
} from "../master/state.js";

const worker: WorkerRef = {
	name: "worker-1",
	model: "test/worker",
	thinking: "medium",
	status: "working",
	sessionPath: "/tmp/subagents/worker-1.jsonl",
};

test("v7 只恢复三种状态及合法标记", () => {
	for (const status of ["working", "idle", "reviewing"] as const) {
		const candidate = {
			...worker,
			status,
			interruptedAt: 1_700_000_000_000,
			reviewNeeded: true,
			disposition: "pending" as const,
		};
		expect(restoreMasterState({ version: 7, workers: [candidate] })).toEqual({ version: 7, workers: [candidate] });
	}
	for (const status of ["starting", "blocked", "dormant"])
		expect(restoreMasterState({ version: 7, workers: [{ ...worker, status }] })).toBeUndefined();
	expect(restoreMasterState({ version: 6, workers: [worker] })).toBeUndefined();
	expect(restoreMasterState({ version: 7, workers: [{ ...worker, interruptedAt: 0 }] })).toBeUndefined();
	expect(restoreMasterState({ version: 7, workers: [{ ...worker, disposition: "done" }] })).toBeUndefined();
});

test("状态归约保留并按发落动作消除中断、审查义务与发落标记", () => {
	let state = reduceMaster(initialMasterState(), { type: "UPSERT_WORKER", worker });
	state = reduceMaster(state, {
		type: "UPSERT_WORKER",
		worker: { ...worker, status: "idle", interruptedAt: 42, reviewNeeded: true, disposition: "pending" },
	});
	expect(state.workers[0]).toMatchObject({ status: "idle", interruptedAt: 42, reviewNeeded: true, disposition: "pending" });
	state = reduceMaster(state, {
		type: "UPSERT_WORKER",
		worker: { ...worker, status: "reviewing", reviewNeeded: true },
	});
	expect(state.workers[0]).toEqual({ ...worker, status: "reviewing", reviewNeeded: true });
	state = reduceMaster(state, { type: "REMOVE_WORKER", name: worker.name });
	expect(state.workers).toEqual([]);
});

test("恢复时在飞状态转为带中断标记的冷 idle，已落定状态不变", () => {
	const state = {
		version: 7 as const,
		workers: [
			worker,
			{ ...worker, name: "review", sessionPath: "/tmp/subagents/review.jsonl", status: "reviewing" as const, reviewNeeded: true },
			{ ...worker, name: "idle", sessionPath: "/tmp/subagents/idle.jsonl", status: "idle" as const },
		],
	};
	const recovered = recoverMasterState(state, 1234);
	expect(recovered.workers).toEqual([
		{ ...worker, status: "idle", interruptedAt: 1234 },
		{ ...worker, name: "review", sessionPath: "/tmp/subagents/review.jsonl", status: "idle", reviewNeeded: true, interruptedAt: 1234 },
		{ ...worker, name: "idle", sessionPath: "/tmp/subagents/idle.jsonl", status: "idle" },
	]);
});

test("重名身份漂移与重复 sessionPath 均拒绝", () => {
	const state = reduceMaster(initialMasterState(), { type: "UPSERT_WORKER", worker });
	expect(() => reduceMaster(state, {
		type: "UPSERT_WORKER",
		worker: { ...worker, sessionPath: "/tmp/subagents/other.jsonl" },
	})).toThrow("不能更换 sessionPath");
	expect(() => reduceMaster(state, {
		type: "UPSERT_WORKER",
		worker: { ...worker, name: "worker-2" },
	})).toThrow("sessionPath 已被占用");
	expect(restoreMasterState({ version: 7, workers: [worker, worker] })).toBeUndefined();
	expect(restoreMasterState({ version: 7, workers: [worker, { ...worker, name: "worker-2" }] })).toBeUndefined();
});

test("v6 只读报旧版错误，状态所有者丢弃并记录清理告知依据", async () => {
	const directory = await mkdtemp(join(tmpdir(), "firecode-master-v7-"));
	const path = join(directory, "state.json");
	await writeFile(path, JSON.stringify({ version: 6, workers: [worker] }));
	expect(() => loadMasterState(path)).toThrow(LegacyMasterStateError);
	const store = new MasterStore(path);
	expect(store.state).toEqual(initialMasterState());
	expect(store.discardedLegacyVersion).toBe(6);
	expect(await readdir(directory)).toEqual([]);
	await rm(directory, { recursive: true, force: true });
});

test("Worker Pool 以 0600 原子覆盖唯一状态文件", async () => {
	const directory = await mkdtemp(join(tmpdir(), "firecode-master-state-"));
	const path = join(directory, "state.json");
	const store = new MasterStore(path);
	store.dispatch({ type: "UPSERT_WORKER", worker });
	expect(await readdir(directory)).toEqual(["state.json"]);
	expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 7, workers: [worker] });
	store.dispatch({ type: "CLEAR" });
	expect(await readdir(directory)).toEqual([]);
	await rm(directory, { recursive: true, force: true });
});
