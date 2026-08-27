import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBarkPayload, hasPendingDisposition } from "../session/bark.js";

const worker = (disposition?: "pending" | "reminded") => ({
	name: "w1",
	role: "工程师",
	model: "openai-codex/gpt-5.6-sol",
	thinking: "medium",
	status: "idle",
	sessionPath: "/tmp/w1.jsonl",
	...(disposition ? { disposition } : {}),
});

test("有待拍板事件时升 timeSensitive 并带副标题，否则 active 无副标题", () => {
	const base = { title: "s", body: "b", group: "g", sessionId: "sid" };
	const urgent = buildBarkPayload({ ...base, awaitingDecision: true });
	expect(urgent.level).toBe("timeSensitive");
	expect(urgent.subtitle).toBe("待拍板");
	const normal = buildBarkPayload({ ...base, awaitingDecision: false });
	expect(normal.level).toBe("active");
	expect(normal.subtitle).toBeUndefined();
	// 同会话固定 id：新通知经 APNs CollapseID 顶掉旧通知。
	expect(urgent.id).toBe("sid");
});

test("v8 待发落 Worker 触发待拍板，空池、文件缺失与损坏均不触发", async () => {
	const dir = await mkdtemp(join(tmpdir(), "firecode-bark-"));
	try {
		const path = join(dir, "state.json");
		await writeFile(path, JSON.stringify({ version: 8, workers: [worker("pending")] }));
		expect(hasPendingDisposition(path)).toBe(true);
		await writeFile(path, JSON.stringify({ version: 8, workers: [worker()] }));
		expect(hasPendingDisposition(path)).toBe(false);
		expect(hasPendingDisposition(join(dir, "missing.json"))).toBe(false);
		await writeFile(path, "not json");
		expect(hasPendingDisposition(path)).toBe(false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
