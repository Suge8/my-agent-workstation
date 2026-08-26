import { afterEach, describe, expect, test } from "bun:test";
import type { ReviewLimits, ReviewState, ReviewerResult } from "../review/state.js";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader.ts";

type Reduce = typeof import("../review/state.js").reduce;
type InitialState = typeof import("../review/state.js").initialState;

let reduce: Reduce;
let initialState: InitialState;

const LIMITS: ReviewLimits = {
	maxRounds: 3,
	advisorAfterFailures: 2,
	advisorModel: "p/advisor",
	reviewers: [
		{ model: "p/sol", thinking: "high" },
		{ model: "p/terra", thinking: "high" },
	],
};

function reviewer(index: number, status: ReviewerResult["status"], details: string): ReviewerResult {
	return { index, model: `m${index}`, thinking: "high", status, summary: "s", details };
}

function settle(state: ReviewState, index: number, status: ReviewerResult["status"], details = "d") {
	return reduce(state, { type: "REVIEWER_SETTLED", index, result: reviewer(index, status, details) }, LIMITS, 10_000 + index);
}

function completeRepair(state: ReviewState, limits = LIMITS, now = 20_000): ReviewState {
	state = reduce(state, { type: "FEEDBACK_DISPATCHED" }, limits, now - 3).state;
	state = reduce(state, { type: "REPAIR_STARTED" }, limits, now - 2).state;
	return reduce(state, { type: "REPAIR_COMPLETED" }, limits, now - 1).state;
}

async function loadState() {
	const module = (await loadFirecodeModule("review/state.ts")) as {
		reduce: Reduce;
		initialState: InitialState;
	};
	reduce = module.reduce;
	initialState = module.initialState;
}

afterEach(cleanupFirecodeModules);

describe("fire-review reducer", () => {
	test("START while idle begins reviewing round 1 with start card and reviewers", async () => {
		await loadState();
		const result = reduce(initialState("g"), { type: "START", focus: "审 auth", busy: false }, LIMITS, 1000);
		expect(result.state.phase).toBe("reviewing");
		expect(result.state.round).toBe(1);
		expect(result.state.active?.reviewers).toHaveLength(2);
		expect(result.state.focus).toBe("审 auth");
		expect(result.effects.map((e) => e.kind)).toEqual(["send_card", "advance"]);
		expect(result.effects[0]).toMatchObject({ kind: "send_card", card: { kind: "start", models: ["p/sol", "p/terra"] } });
	});

	test("START while busy queues silently and waits for runtime completion", async () => {
		await loadState();
		const result = reduce(initialState("g"), { type: "START", focus: "x", busy: true }, LIMITS, 1000);
		expect(result.state.phase).toBe("queued");
		expect(result.state.round).toBe(0);
		// 排队不发卡：状态栏与活动条已各有提示，记录只留开始/结果卡。
		expect(result.effects).toMatchObject([{ kind: "advance" }]);
	});

	test("START while a review is active is ignored", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false }, LIMITS, 1000).state;
		const result = reduce(state, { type: "START", focus: "again", busy: false }, LIMITS, 2000);
		expect(result.state).toBe(state);
		expect(result.effects).toEqual([]);
	});

	test("all reviewers pass records the round then runs a summary turn before settling", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false }, LIMITS, 1000).state;
		state = settle(state, 0, "passed", "PASS\n验证命令 exit 0\n证据：文件=a.ts；命令=ls").state;
		const result = settle(state, 1, "passed", "PASS\nok\n证据：文件=b.ts；命令=cat b.ts");
		// 质量裁决终态先进总结相：结果卡照发，总结回合结束才 settled。
		expect(result.state.phase).toBe("summarizing");
		expect(result.state.summary).toEqual({ kind: "passed", status: "pending" });
		expect(result.state.history).toHaveLength(1);
		expect(result.state.history[0].result).toBe("passed");
		expect(result.state.history[0].reviewers).toHaveLength(2);
		expect(result.effects).toMatchObject([
			{ kind: "send_card", card: { kind: "pass", summary: "• m0：s\n• m1：s" } },
			{ kind: "advance" },
		]);
		// 总结生命周期：投递 → 回合启动 → 回合结束 → settled，中途状态均可持久化。
		let current = reduce(result.state, { type: "SUMMARY_DISPATCHED" }, LIMITS, 4000).state;
		expect(current.summary?.status).toBe("awaiting_start");
		current = reduce(current, { type: "SUMMARY_STARTED" }, LIMITS, 5000).state;
		expect(current.summary?.status).toBe("running");
		const settledResult = reduce(current, { type: "SUMMARY_SETTLED" }, LIMITS, 6000);
		expect(settledResult.state.phase).toBe("settled");
		expect(settledResult.state.summary).toBeNull();
		expect(settledResult.effects).toEqual([]);
	});

	test("RECOVER re-arms an interrupted summary turn; CANCEL during summarizing settles quietly", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false }, LIMITS, 1000).state;
		state = settle(state, 0, "passed", "PASS\n证据：文件=a.ts；命令=ls").state;
		state = settle(state, 1, "passed", "PASS\n证据：文件=b.ts；命令=ls").state;
		state = reduce(state, { type: "SUMMARY_DISPATCHED" }, LIMITS, 4000).state;
		state = reduce(state, { type: "SUMMARY_STARTED" }, LIMITS, 5000).state;
		// reload 中断未完成的总结回合 → 重置 pending 重投。
		const recovered = reduce(state, { type: "RECOVER" }, LIMITS, 6000).state;
		expect(recovered.phase).toBe("summarizing");
		expect(recovered.summary).toEqual({ kind: "passed", status: "pending" });
		// 取消/退出：裁决与结果卡已落地，静默收尾，不追加轮记录不发卡。
		const cancelled = reduce(recovered, { type: "CANCEL", reason: "user" }, LIMITS, 7000);
		expect(cancelled.state.phase).toBe("settled");
		expect(cancelled.state.history).toHaveLength(1);
		expect(cancelled.state.history[0].result).toBe("passed");
		expect(cancelled.effects).toEqual([]);
	});

	test("single-model PASS keeps non-blocking suggestions while dropping evidence", async () => {
		await loadState();
		const one: ReviewLimits = { ...LIMITS, reviewers: [LIMITS.reviewers[0]] };
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false }, one, 1000).state;
		const result = reduce(state, {
			type: "REVIEWER_SETTLED",
			index: 0,
			result: {
				...reviewer(0, "passed", "核心逻辑已核对\n证据：文件=a.ts；命令=bun test\n## 建议（非阻塞）\n- 清理命名"),
				summary: "核心逻辑已核对",
			},
		}, one, 2000);
		const effect = result.effects[0];
		const summary = effect?.kind === "send_card" && effect.card.kind === "pass" ? effect.card.summary : "";
		expect(summary).toContain("核心逻辑已核对");
		expect(summary).toContain("## 建议（非阻塞）\n- 清理命名");
		expect(summary).not.toContain("证据：");
	});

	test("multi-model PASS merges and deduplicates non-blocking suggestions", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false }, LIMITS, 1000).state;
		state = reduce(state, {
			type: "REVIEWER_SETTLED",
			index: 0,
			result: { ...reviewer(0, "passed", "ok\n## 建议（非阻塞）\n- 清理命名"), summary: "核心逻辑已核对" },
		}, LIMITS, 2000).state;
		const result = reduce(state, {
			type: "REVIEWER_SETTLED",
			index: 1,
			result: { ...reviewer(1, "passed", "ok\n## 建议（非阻塞）\n- 清理命名"), summary: "测试已通过" },
		}, LIMITS, 3000);
		const effect = result.effects[0];
		const summary = effect?.kind === "send_card" && effect.card.kind === "pass" ? effect.card.summary : "";
		expect(summary).toContain("• m0：核心逻辑已核对");
		expect(summary.match(/清理命名/gu)).toHaveLength(1);
	});

	test("a later PASS card recaps findings closed since prior failed rounds", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false }, LIMITS, 1000).state;
		state = settle(state, 0, "failed", "FAIL\n## 发现 1\n- 问题: stale lock").state;
		state = settle(state, 1, "passed", "PASS\nok").state;
		state = reduce(completeRepair(state), { type: "ADVANCE" }, LIMITS, 20_000).state;
		state = settle(state, 0, "passed", "PASS\nok").state;
		const result = settle(state, 1, "passed", "PASS\nok");
		const effect = result.effects[0];
		const summary = effect?.kind === "send_card" && effect.card.kind === "pass" ? effect.card.summary : "";
		expect(summary).toContain("**本次收口的问题**：");
		expect(summary).toContain("• stale lock（第 1 轮）");
	});

	test("any FAIL records pending repair and requests guarded advancement", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false }, LIMITS, 1000).state;
		state = settle(state, 0, "failed", "FAIL\n发现 1").state;
		const result = settle(state, 1, "passed", "PASS\n证据：文件=a.ts；命令=ls");
		expect(result.state.phase).toBe("awaiting_fix");
		expect(result.state.history[0].result).toBe("failed");
		// 失败轮先发可见卡，再由统一 barrier 投隐藏反馈。
		expect(result.effects).toMatchObject([
			{ kind: "send_card", card: { kind: "fail", round: 1 } },
			{ kind: "advance" },
		]);
		const card = result.effects[0]?.kind === "send_card" ? result.effects[0].card : undefined;
		expect(card && "details" in card ? card.details : "").toContain("模型 1 · m0");
		expect(card && "details" in card ? card.details : "").toContain("模型 2 · m1");
		expect(result.state.repair?.details).toContain("模型 1 · m0");
		expect(result.state.repair?.details).not.toContain("模型 2 · m1");
	});

	test("consecutive failures reaching the threshold requests advisor advancement", async () => {
		await loadState();
		// round 1 fails and completes its repair
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false }, LIMITS, 1000).state;
		state = settle(state, 0, "failed", "FAIL\n发现 1").state;
		state = settle(state, 1, "failed", "FAIL\n发现 2").state;
		expect(state.phase).toBe("awaiting_fix");
		// agent fixes, round 2 begins
		state = reduce(completeRepair(state), { type: "ADVANCE" }, LIMITS, 20_000).state;
		expect(state.round).toBe(2);
		// round 2 fails -> consecutiveFailures = 2 >= advisorAfterFailures
		state = settle(state, 0, "failed", "FAIL\n发现 3").state;
		const result = settle(state, 1, "failed", "FAIL\n发现 4");
		expect(result.state.phase).toBe("needs_fix");
		expect(result.state.consecutiveFailures).toBe(2);
		expect(result.effects).toMatchObject([
			{ kind: "send_card", card: { kind: "fail", round: 2 } },
			{ kind: "advance" },
		]);
	});

	test("advisor continue delivers feedback and waits for fix", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false }, LIMITS, 1000).state;
		state = settle(state, 0, "failed", "FAIL\n发现 1").state;
		state = settle(state, 1, "failed", "FAIL\n发现 2").state;
		state = reduce(completeRepair(state), { type: "ADVANCE" }, LIMITS, 20_000).state;
		state = settle(state, 0, "failed", "FAIL\n发现 3").state;
		state = settle(state, 1, "failed", "FAIL\n发现 4").state;
		const result = reduce(state, { type: "ADVISOR_SETTLED", result: { verdict: "continue", advice: "继续修" } }, LIMITS, 30_000);
		expect(result.state.phase).toBe("awaiting_fix");
		expect(result.state.history[1].advisor?.verdict).toBe("continue");
		// 失败卡已在咨询前可见；咨询完成补 pi-flow 的中性顾问建议卡。
		expect(result.effects).toMatchObject([
			{
				kind: "send_card",
				card: { kind: "advisor", advisor: { verdict: "continue" }, advisorModel: "p/advisor" },
			},
			{ kind: "advance" },
		]);
	});

	// narrow 在 reducer 层与 continue 同样投反馈；两者的差别在反馈文本的范围约束，
	// 由 review-card-checkpoint 里的 prompt 用例把守。
	test("advisor narrow keeps the loop going and carries the advisor scope", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false }, LIMITS, 1000).state;
		state = settle(state, 0, "failed", "FAIL\n发现 1").state;
		state = settle(state, 1, "failed", "FAIL\n发现 2").state;
		state = reduce(completeRepair(state), { type: "ADVANCE" }, LIMITS, 20_000).state;
		state = settle(state, 0, "failed", "FAIL\n发现 3").state;
		state = settle(state, 1, "failed", "FAIL\n发现 4").state;
		const result = reduce(state, { type: "ADVISOR_SETTLED", result: { verdict: "narrow", advice: "收窄" } }, LIMITS, 30_000);
		expect(result.state.phase).toBe("awaiting_fix");
		expect(result.effects).toMatchObject([
			{
				kind: "send_card",
				card: { kind: "advisor", advisor: { verdict: "narrow" }, advisorModel: "p/advisor" },
			},
			{ kind: "advance" },
		]);
	});

	test("skipping advisor continues to repair without cancelling the review", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false }, LIMITS, 1000).state;
		state = settle(state, 0, "failed", "FAIL\n发现 1").state;
		state = settle(state, 1, "failed", "FAIL\n发现 2").state;
		state = reduce(completeRepair(state), { type: "ADVANCE" }, LIMITS, 20_000).state;
		state = settle(state, 0, "failed", "FAIL\n发现 3").state;
		state = settle(state, 1, "failed", "FAIL\n发现 4").state;
		expect(state.phase).toBe("needs_fix");
		const result = reduce(state, { type: "ADVISOR_SKIPPED" }, LIMITS, 30_000);
		expect(result.state.phase).toBe("awaiting_fix");
		expect(result.state.repair?.advisor).toBeNull();
		expect(result.effects).toEqual([{ kind: "advance" }]);
	});

	test("advisor stop settles the review as stopped", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false }, LIMITS, 1000).state;
		state = settle(state, 0, "failed", "FAIL\n发现 1").state;
		state = settle(state, 1, "failed", "FAIL\n发现 2").state;
		state = reduce(completeRepair(state), { type: "ADVANCE" }, LIMITS, 20_000).state;
		state = reduce(state, { type: "REVIEWER_SETTLED", index: 0, result: reviewer(0, "failed", "FAIL\n发现 3") }, LIMITS, 21_000).state;
		state = reduce(state, { type: "REVIEWER_SETTLED", index: 1, result: reviewer(1, "failed", "FAIL\n发现 4") }, LIMITS, 22_000).state;
		const result = reduce(state, { type: "ADVISOR_SETTLED", result: { verdict: "stop", advice: "别修了" } }, LIMITS, 30_000);
		expect(result.state.phase).toBe("summarizing");
		expect(result.state.summary).toEqual({ kind: "advisor_stop", status: "pending" });
		expect(result.state.history).toHaveLength(2);
		expect(result.state.history[1].result).toBe("stopped");
		// 本轮 findings 已在咨询前显示；终止卡只给顾问裁决，不能重复整张失败报告。
		// elapsedMs 是咨询时长（进入顾问相 22_000 → 裁决 30_000），与顾问建议卡同一语义；轮时长已在失败卡显示。
		expect(result.effects).toEqual([
			{
				kind: "send_card",
				card: {
					kind: "stop",
					reason: "advisor",
					round: 2,
					details: "别修了",
					advisor: { verdict: "stop", advice: "别修了" },
					advisorModel: "p/advisor",
					elapsedMs: 8_000,
					totalElapsedMs: 29_000,
				},
			},
			{ kind: "advance" },
		]);
	});

	test("ADVANCE from queued begins round 1", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "f", busy: true }, LIMITS, 1000).state;
		const result = reduce(state, { type: "ADVANCE" }, LIMITS, 2000);
		expect(result.state.phase).toBe("reviewing");
		expect(result.state.round).toBe(1);
		expect(result.state.focus).toBe("f");
		expect(result.effects.map((e) => e.kind)).toEqual(["send_card", "advance"]);
	});

	test("RECOVER resets an unconfirmed repair instead of advancing the round", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false }, LIMITS, 1000).state;
		state = settle(state, 0, "failed", "FAIL\n发现 1").state;
		state = settle(state, 1, "failed", "FAIL\n发现 2").state;
		state = reduce(state, { type: "FEEDBACK_DISPATCHED" }, LIMITS, 20_000).state;
		expect(state.repair?.status).toBe("awaiting_start");
		const recovered = reduce(state, { type: "RECOVER" }, LIMITS, 21_000);
		expect(recovered.state.round).toBe(1);
		expect(recovered.state.repair?.status).toBe("pending");
		expect(recovered.effects).toEqual([]);
	});

	test("ADVANCE from awaiting_fix advances to the next round", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false }, LIMITS, 1000).state;
		state = settle(state, 0, "failed", "FAIL\n发现 1").state;
		state = settle(state, 1, "failed", "FAIL\n发现 2").state;
		const result = reduce(completeRepair(state), { type: "ADVANCE" }, LIMITS, 20_000);
		expect(result.state.round).toBe(2);
		expect(result.state.phase).toBe("reviewing");
		expect(result.state.history).toHaveLength(1);
		// 开始卡只发第 1 轮；后续轮的边界由结果卡轮号承担。
		expect(result.effects).toMatchObject([{ kind: "advance" }]);
	});

	test("ADVANCE at maxRounds stops instead of opening another round", async () => {
		await loadState();
		const local = { ...LIMITS, maxRounds: 1 };
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false }, local, 1000).state;
		state = settle(state, 0, "failed", "FAIL\n发现 1").state;
		state = settle(state, 1, "failed", "FAIL\n发现 2").state;
		expect(state.phase).toBe("awaiting_fix");
		const result = reduce(completeRepair(state, local), { type: "ADVANCE" }, local, 20_000);
		expect(result.state.phase).toBe("summarizing");
		expect(result.state.summary).toEqual({ kind: "max_rounds", status: "pending" });
		expect(result.effects).toMatchObject([
			{ kind: "send_card", card: { kind: "stop", reason: "max_rounds" } },
			{ kind: "advance" },
		]);
	});

	test("a FAIL at the max round settles directly without delivering feedback", async () => {
		await loadState();
		const local = { ...LIMITS, maxRounds: 1 };
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false }, local, 1000).state;
		state = reduce(state, { type: "REVIEWER_SETTLED", index: 0, result: reviewer(0, "failed", "FAIL\n发现 1") }, local, 2000).state;
		const result = reduce(state, { type: "REVIEWER_SETTLED", index: 1, result: reviewer(1, "failed", "FAIL\n发现 2") }, local, 3000);
		expect(result.state.phase).toBe("summarizing");
		expect(result.state.summary).toEqual({ kind: "max_rounds", status: "pending" });
		expect(result.state.history[0].result).toBe("failed");
		expect(result.effects).toMatchObject([
			{ kind: "send_card", card: { kind: "stop", reason: "max_rounds" } },
			{ kind: "advance" },
		]);
	});

	test("ADVANCE is ignored while idle or reviewing", async () => {
		await loadState();
		const idle = reduce(initialState("g"), { type: "ADVANCE" }, LIMITS, 1000);
		expect(idle.state.phase).toBe("idle");
		expect(idle.effects).toEqual([]);
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false }, LIMITS, 1000).state;
		const reviewing = reduce(state, { type: "ADVANCE" }, LIMITS, 2000);
		expect(reviewing.state.phase).toBe("reviewing");
		expect(reviewing.state.round).toBe(1);
	});

	test("all reviewers error settles as infrastructure error without a failed round", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false }, LIMITS, 1000).state;
		state = settle(state, 0, "error", "审查会话超时").state;
		const result = settle(state, 1, "error", "审查会话启动失败");
		expect(result.state.phase).toBe("settled");
		expect(result.state.history[0].result).toBe("error");
		expect(result.effects).toMatchObject([{ kind: "send_card", card: { kind: "error" } }]);
	});

	test("CANCEL from reviewing settles with a cancelled round and card", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false }, LIMITS, 1000).state;
		state = settle(state, 0, "passed", "PASS\n证据：文件=a.ts；命令=ls").state;
		const result = reduce(state, { type: "CANCEL", reason: "user" }, LIMITS, 5000);
		expect(result.state.phase).toBe("settled");
		expect(result.state.history[0].result).toBe("cancelled");
		expect(result.effects).toMatchObject([{ kind: "send_card", card: { kind: "cancel" } }]);
	});

	test("CANCEL while idle is ignored", async () => {
		await loadState();
		const result = reduce(initialState("g"), { type: "CANCEL", reason: "user" }, LIMITS, 1000);
		expect(result.state.phase).toBe("idle");
		expect(result.effects).toEqual([]);
	});

	test("TIMEOUT from awaiting_fix settles; the round was already recorded as failed", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false }, LIMITS, 1000).state;
		state = settle(state, 0, "failed", "FAIL\n发现 1").state;
		state = settle(state, 1, "failed", "FAIL\n发现 2").state;
		const result = reduce(state, { type: "TIMEOUT" }, LIMITS, 50_000);
		expect(result.state.phase).toBe("settled");
		expect(result.state.history[0].result).toBe("failed");
		expect(result.effects).toMatchObject([{ kind: "send_card", card: { kind: "timeout" } }]);
	});

	test("history is append-only: earlier round records are never mutated", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false }, LIMITS, 1000).state;
		state = settle(state, 0, "failed", "FAIL\n发现 1").state;
		state = settle(state, 1, "failed", "FAIL\n发现 2").state;
		const first = state.history[0];
		const before = JSON.stringify(state.history[0]);
		state = reduce(completeRepair(state), { type: "ADVANCE" }, LIMITS, 20_000).state;
		state = settle(state, 0, "passed", "PASS\n证据：文件=a.ts；命令=ls").state;
		const result = settle(state, 1, "passed", "PASS\n证据：文件=b.ts；命令=cat b.ts");
		expect(result.state.history).toHaveLength(2);
		expect(JSON.stringify(result.state.history[0])).toBe(before);
		expect(result.state.history[0]).toBe(first);
	});

	test("round numbers are monotonic across the loop", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false }, LIMITS, 1000).state;
		const rounds = [state.round];
		state = settle(state, 0, "failed", "FAIL\n发现 1").state;
		state = settle(state, 1, "failed", "FAIL\n发现 2").state;
		state = reduce(completeRepair(state), { type: "ADVANCE" }, LIMITS, 20_000).state;
		rounds.push(state.round);
		state = settle(state, 0, "failed", "FAIL\n发现 3").state;
		state = settle(state, 1, "failed", "FAIL\n发现 4").state;
		// 第二轮触发顾问仲裁，仲裁 continue 后进修复，repair completion 再开第三轮
		state = reduce(state, { type: "ADVISOR_SETTLED", result: { verdict: "continue", advice: "继续" } }, LIMITS, 30_000).state;
		state = reduce(completeRepair(state, LIMITS, 40_000), { type: "ADVANCE" }, LIMITS, 40_000).state;
		rounds.push(state.round);
		expect(rounds).toEqual([1, 2, 3]);
	});

	test("an error vote stays labeled by its own model in the archived infrastructure failure", async () => {
		await loadState();
		const three: ReviewLimits = {
			...LIMITS,
			reviewers: [...LIMITS.reviewers, { model: "p/luna", thinking: "high" }],
		};
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false }, three, 1000).state;
		state = reduce(state, { type: "REVIEWER_SETTLED", index: 0, result: reviewer(0, "passed", "PASS\n证据：文件=a.ts；命令=ls") }, three, 1000).state;
		state = reduce(state, { type: "REVIEWER_SETTLED", index: 1, result: reviewer(1, "passed", "PASS\n证据：文件=b.ts；命令=ls") }, three, 1000).state;
		const settled = reduce(state, { type: "REVIEWER_SETTLED", index: 2, result: reviewer(2, "error", "审查会话超时") }, three, 1000);
		expect(settled.state.phase).toBe("settled");
		expect(settled.state.history[0].result).toBe("error");
		expect(settled.state.history[0].details).toContain("模型 1 · m0\nPASS");
		expect(settled.state.history[0].details).toContain("模型 3 · m2\n审查会话超时");
		expect(settled.state.history[0].details).not.toContain("PASS · m2");
	});

	// 格式错误票可忽略，但必须至少留下一张有效 PASS 才能形成质量结论。
	test("a minority format-error vote is ignored when valid PASS votes remain", async () => {
		await loadState();
		const three: ReviewLimits = {
			...LIMITS,
			reviewers: [...LIMITS.reviewers, { model: "p/luna", thinking: "high" }],
		};
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false }, three, 1000).state;
		state = reduce(state, { type: "REVIEWER_SETTLED", index: 0, result: reviewer(0, "passed", "PASS\nok") }, three, 2000).state;
		state = reduce(state, { type: "REVIEWER_SETTLED", index: 1, result: reviewer(1, "passed", "PASS\nok") }, three, 2000).state;
		const result = reduce(state, {
			type: "REVIEWER_SETTLED",
			index: 2,
			result: reviewer(2, "error", "审查输出格式无效：第一行必须是 PASS 或 FAIL"),
		}, three, 3000);
		expect(result.state.history[0].result).toBe("passed");
		const effect = result.effects[0];
		const summary = effect?.kind === "send_card" && effect.card.kind === "pass" ? effect.card.summary : "";
		expect(summary).not.toContain("m2");
	});

	test("all format-error votes are unavailable rather than an empty PASS", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false }, LIMITS, 1000).state;
		state = settle(state, 0, "error", "审查输出格式无效：缺少证据").state;
		const result = settle(state, 1, "error", "审查输出格式无效：缺少发现");
		expect(result.state.history[0].result).toBe("error");
		expect(result.effects).toMatchObject([{ kind: "send_card", card: { kind: "error" } }]);
	});

	test("a non-format reviewer error makes mixed FAIL infrastructure unavailable", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false }, LIMITS, 1000).state;
		state = settle(state, 0, "failed", "FAIL\n发现 1").state;
		const result = settle(state, 1, "error", "审查会话认证失败");
		expect(result.state.history[0].result).toBe("error");
		expect(result.effects).toMatchObject([{ kind: "send_card", card: { kind: "error" } }]);
	});

	test("advisor infrastructure failure settles as unavailable instead of continuing", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false }, LIMITS, 1000).state;
		state = settle(state, 0, "failed", "FAIL\n发现 1").state;
		state = settle(state, 1, "failed", "FAIL\n发现 2").state;
		state = reduce(completeRepair(state), { type: "ADVANCE" }, LIMITS, 20_000).state;
		state = settle(state, 0, "failed", "FAIL\n发现 3").state;
		state = settle(state, 1, "failed", "FAIL\n发现 4").state;
		const result = reduce(state, { type: "INFRASTRUCTURE_ERROR", details: "顾问会话额度不足" }, LIMITS, 30_000);
		expect(result.state.phase).toBe("settled");
		expect(result.state.history.at(-1)?.result).toBe("error");
		expect(result.effects).toEqual([{
			kind: "send_card",
			card: { kind: "error", message: "顾问会话额度不足" },
		}]);
	});

	test("any non-format reviewer error blocks PASS like pi-flow", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false }, LIMITS, 1000).state;
		state = settle(state, 0, "passed", "PASS\nok").state;
		const result = settle(state, 1, "error", "审查会话超时");
		expect(result.state.history[0].result).toBe("error");
		expect(result.effects).toMatchObject([{ kind: "send_card", card: { kind: "error" } }]);
	});

	test("a round where most reviewers errored is an infra error, not a pass", async () => {
		await loadState();
		const three: ReviewLimits = {
			...LIMITS,
			reviewers: [...LIMITS.reviewers, { model: "p/luna", thinking: "high" }],
		};
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false }, three, 1000).state;
		state = reduce(state, { type: "REVIEWER_SETTLED", index: 0, result: reviewer(0, "passed", "PASS\n证据：文件=a.ts；命令=ls") }, three, 1000).state;
		state = reduce(state, { type: "REVIEWER_SETTLED", index: 1, result: reviewer(1, "error", "会话超时") }, three, 1000).state;
		const settled = reduce(state, { type: "REVIEWER_SETTLED", index: 2, result: reviewer(2, "error", "会话启动失败") }, three, 1000);
		expect(settled.state.history[0].result).toBe("error");
		expect(settled.effects).toMatchObject([{ kind: "send_card", card: { kind: "error" } }]);
	});

	test("cancelled and timed-out rounds carry a reason enum, not display text", async () => {
		await loadState();
		let state = reduce(initialState("g"), { type: "START", focus: "", busy: false }, LIMITS, 1000).state;
		state = settle(state, 0, "passed", "PASS\n证据：文件=a.ts；命令=ls").state;
		const cancelled = reduce(state, { type: "CANCEL", reason: "user" }, LIMITS, 5000);
		expect(cancelled.state.history[0].reason).toBe("user");
		expect(cancelled.state.history[0].details).toBe("");
		expect(cancelled.effects[0]).toMatchObject({ kind: "send_card", card: { kind: "cancel", reason: "user" } });

		let timed = reduce(initialState("g2"), { type: "START", focus: "", busy: false }, LIMITS, 1000).state;
		timed = settle(timed, 0, "passed", "PASS\n证据：文件=a.ts；命令=ls").state;
		const timedOut = reduce(timed, { type: "TIMEOUT" }, LIMITS, 9000);
		expect(timedOut.state.history[0].reason).toBe("timeout");
		expect(timedOut.effects[0]).toMatchObject({ kind: "send_card", card: { kind: "timeout", reason: "timeout" } });
	});
});
