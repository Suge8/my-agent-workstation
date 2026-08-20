import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBarkPayload, hasBlockedWorker } from "../session/bark.js";

const worker = (status: string) => ({
	name: "w1",
	model: "openai-codex/gpt-5.6-sol",
	thinking: "medium",
	status,
	paneId: "p1",
	tabId: "t1",
});
const worker2 = (status: string) => ({ ...worker(status), name: "w2", paneId: "p2", tabId: "t2" });

test("有工人待拍板时升 timeSensitive 并带副标题，否则 active 无副标题", () => {
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

test("hasBlockedWorker：blocked 为真；全忙、文件缺失、文件损坏都为假", async () => {
	const dir = await mkdtemp(join(tmpdir(), "firecode-bark-"));
	try {
		const path = join(dir, "state.json");
		await writeFile(path, JSON.stringify({ version: 5, workers: [worker("working"), worker2("blocked")] }));
		expect(hasBlockedWorker(path)).toBe(true);
		await writeFile(path, JSON.stringify({ version: 5, workers: [worker("working")] }));
		expect(hasBlockedWorker(path)).toBe(false);
		expect(hasBlockedWorker(join(dir, "missing.json"))).toBe(false);
		await writeFile(path, "not json");
		expect(hasBlockedWorker(path)).toBe(false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
