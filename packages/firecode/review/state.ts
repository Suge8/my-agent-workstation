/**
 * /fire-review 的状态机：唯一事实源，纯 reducer，零 IO 零副作用。
 *
 * 循环状态只存在这一个 reducer 里：模块级不持有可变循环状态，
 * 持久化与 UI 都是本状态在 checkpoint / 结果卡上的投影。
 *
 * 相：idle → queued → reviewing → needs_fix → awaiting_fix → reviewing，终态 settled；
 * 质量裁决终态（通过 / 顾问叫停 / maxRounds 用尽）先经 summarizing：投递一个总结回合
 * 让执行模型用人话收尾（修了什么/为何过不了），回合结束才落 settled；
 * 事故终态（取消 / 超时 / 基础设施错误）直接 settled，不烧总结回合。
 * 不变量：同一时刻至多一个活动轮；round 单调递增；history 只追加不改写。
 */
export type Phase =
	| "idle"
	| "queued"
	| "reviewing"
	| "needs_fix"
	| "awaiting_fix"
	| "summarizing"
	| "settled";

export type ReviewerStatus = "running" | "passed" | "failed" | "error";
export type RoundResult = "passed" | "failed" | "error" | "stopped" | "cancelled" | "timed_out";
export type AdvisorVerdict = "continue" | "stop" | "narrow";
export type StopReason = "advisor" | "max_rounds" | "user" | "shutdown" | "timeout";

/** 单个审查者的输出（output 契约解析结果，纯数据）。 */
export interface ReviewerResult {
	index: number;
	model: string;
	thinking: string;
	status: Exclude<ReviewerStatus, "running">;
	/** 短摘要：PASS 一行收敛摘要 / FAIL 发现一句话。 */
	summary: string;
	/** 全文：PASS 摘要+证据锚点 / FAIL 发现列表。归档用。 */
	details: string;
}

/** 审查中某个审查者的进行状态；settled 后携带完整结果。 */
export interface ActiveReviewer {
	index: number;
	model: string;
	thinking: string;
	status: ReviewerStatus;
	result: ReviewerResult | null;
}

/** 当前轮的审查者集合。 */
export interface ActiveCheck {
	round: number;
	reviewers: ActiveReviewer[];
	settledCount: number;
}

export interface AdvisorResult {
	verdict: AdvisorVerdict;
	advice: string;
}

/** 一轮已收口的记录；只追加不改写。 */
export interface ReviewRound {
	round: number;
	result: RoundResult;
	/** 全文归档：PASS 摘要 / FAIL 发现列表 / advisor 建议等。 */
	details: string;
	reviewers: ReviewerResult[];
	advisor?: AdvisorResult;
	/** 取消 / 超时 / 停止的终止原因（展示层解析文案）。 */
	reason?: StopReason;
	elapsedMs: number;
}

/** 已判 FAIL 但尚未收口的轮：等顾问仲裁或直接投递反馈。 */
export interface PendingRound {
	round: number;
	reviewers: ReviewerResult[];
	details: string;
}

export type RepairStatus = "pending" | "awaiting_start" | "running" | "completed";

/** FAIL 后的修复回合。必须持久化，reload 才不会跳过尚未启动的反馈。 */
export interface RepairState {
	details: string;
	advisor: AdvisorResult | null;
	status: RepairStatus;
}

export type SummaryKind = "passed" | "max_rounds" | "advisor_stop";
export type SummaryStatus = "pending" | "awaiting_start" | "running";

/** 质量裁决终态后的总结回合生命周期；持久化后 reload 才能重投未启动的总结。 */
export interface SummaryState {
	kind: SummaryKind;
	status: SummaryStatus;
}

export interface ReviewState {
	runId: string;
	phase: Phase;
	/** 当前轮号（1 起）；queued 时 0。 */
	round: number;
	focus: string;
	/** 已收口轮，只追加。 */
	history: ReviewRound[];
	/** reviewing 轮的活动检查；其余相为 null。 */
	active: ActiveCheck | null;
	/** FAIL 轮等待顾问收口（needs_fix）。 */
	pending: PendingRound | null;
	/** awaiting_fix 的反馈与修复回合生命周期。 */
	repair: RepairState | null;
	/** summarizing 的总结回合生命周期；其余相为 null。 */
	summary: SummaryState | null;
	/** 连续未通过轮数（顾问仲裁阈值）。 */
	consecutiveFailures: number;
	startedAt: number;
	/** 当前轮起点（本轮用时）。 */
	roundStartedAt: number;
	updatedAt: number;
}

/** reducer 需要的最小配置（限制语义 + 审查者模型清单，纯数据）。 */
export interface ReviewLimits {
	maxRounds: number;
	advisorAfterFailures: number;
	advisorModel: string;
	/** 本轮审查者（model/thinking），beginRound 时填入 active。 */
	reviewers: { model: string; thinking: string }[];
	language?: "zh" | "en";
}

export type ReviewEvent =
	| { type: "START"; focus: string; busy: boolean }
	| { type: "RECOVER" }
	| { type: "REVIEWER_SETTLED"; index: number; result: ReviewerResult }
	| { type: "ADVISOR_SETTLED"; result: AdvisorResult }
	| { type: "ADVISOR_SKIPPED" }
	| { type: "INFRASTRUCTURE_ERROR"; details: string }
	| { type: "ADVANCE" }
	| { type: "FEEDBACK_DISPATCHED" }
	| { type: "REPAIR_STARTED" }
	| { type: "REPAIR_COMPLETED" }
	| { type: "SUMMARY_DISPATCHED" }
	| { type: "SUMMARY_STARTED" }
	| { type: "SUMMARY_SETTLED" }
	| { type: "CANCEL"; reason: "user" | "shutdown" }
	| { type: "TIMEOUT" };

/** 结果卡：executor 渲染成消息；reducer 只决定发哪张、带什么数据。 */
export type CardData =
	| { kind: "start"; round: number; focus: string; models: string[] }
	| { kind: "pass"; round: number; summary: string; details: string; elapsedMs: number; totalElapsedMs?: number }
	| {
			kind: "fail";
			round: number;
			details: string;
			advisor: AdvisorResult | null;
			elapsedMs?: number;
			totalElapsedMs?: number;
	  }
	| { kind: "stop"; reason: "advisor"; round: number; details: string; advisor: AdvisorResult; advisorModel: string; elapsedMs?: number; totalElapsedMs?: number }
	| { kind: "stop"; reason: Exclude<StopReason, "advisor">; round: number; details: string; elapsedMs?: number; totalElapsedMs?: number }
	| { kind: "cancel"; round: number; reason: StopReason }
	| { kind: "timeout"; round: number; reason: StopReason }
	| { kind: "error"; message: string; elapsedMs?: number; totalElapsedMs?: number }
	// advisor 卡的 elapsedMs 是咨询时长（进入 needs_fix 到裁决落定），不是轮时长。
	| { kind: "advisor"; advisor: AdvisorResult; advisorModel: string; elapsedMs?: number };

export type ReviewEffect =
	| { kind: "advance" }
	| { kind: "send_card"; card: CardData };

export interface ReduceResult {
	state: ReviewState;
	effects: ReviewEffect[];
}

export function initialState(runId: string): ReviewState {
	return {
		runId,
		phase: "idle",
		round: 0,
		focus: "",
		history: [],
		active: null,
		pending: null,
		repair: null,
		summary: null,
		consecutiveFailures: 0,
		startedAt: 0,
		roundStartedAt: 0,
		updatedAt: 0,
	};
}

export function reduce(
	state: ReviewState,
	event: ReviewEvent,
	limits: ReviewLimits,
	now: number,
): ReduceResult {
	switch (event.type) {
		case "START":
			return onStart(state, event, limits, now);
		case "RECOVER":
			return onRecover(state);
		case "REVIEWER_SETTLED":
			return onReviewerSettled(state, event, limits, now);
		case "ADVISOR_SETTLED":
			return onAdvisorSettled(state, event, limits, now);
		case "ADVISOR_SKIPPED":
			return onAdvisorSkipped(state, now);
		case "INFRASTRUCTURE_ERROR":
			return onInfrastructureError(state, event.details, now);
		case "ADVANCE":
			return onAdvance(state, limits, now);
		case "FEEDBACK_DISPATCHED":
			return updateRepairStatus(state, "pending", "awaiting_start", now);
		case "REPAIR_STARTED":
			return updateRepairStatus(state, "awaiting_start", "running", now);
		case "REPAIR_COMPLETED":
			return updateRepairStatus(state, "running", "completed", now);
		case "SUMMARY_DISPATCHED":
			return updateSummaryStatus(state, "pending", "awaiting_start", now);
		case "SUMMARY_STARTED":
			return updateSummaryStatus(state, "awaiting_start", "running", now);
		case "SUMMARY_SETTLED":
			return onSummarySettled(state, now);
		case "CANCEL":
			return onCancel(state, event.reason, now);
		case "TIMEOUT":
			return onTimeout(state, now);
	}
}

function onStart(
	state: ReviewState,
	event: Extract<ReviewEvent, { type: "START" }>,
	limits: ReviewLimits,
	now: number,
): ReduceResult {
	if (state.phase === "reviewing" || state.phase === "needs_fix" || state.phase === "awaiting_fix")
		return { state, effects: [] };
	const focus = event.focus.trim();
	// 排队相不发卡：状态栏与活动条已各有一份排队提示，记录里只留开始/结果卡。
	if (event.busy)
		return {
			state: {
				...initialState(state.runId),
				phase: "queued",
				focus,
				startedAt: now,
				updatedAt: now,
			},
			effects: [{ kind: "advance" }],
		};
	return {
		// startedAt 在此落地：排队路径在 queued 写，直接开审路径必须同样记录总耗时起点。
		state: beginRound({ ...initialState(state.runId), startedAt: now }, focus, 1, limits, now),
		effects: [
			{
				kind: "send_card",
				card: {
					kind: "start",
					round: 1,
					focus,
					models: limits.reviewers.map((item) => item.model),
				},
			},
			{ kind: "advance" },
		],
	};
}

function onRecover(state: ReviewState): ReduceResult {
	if (state.phase === "idle" || state.phase === "settled")
		return { state, effects: [] };
	// reload 会中断尚未确认完成的修复/总结回合；重新投递同一份持久化内容，不能跳过。
	const repair =
		state.phase === "awaiting_fix" && state.repair && state.repair.status !== "completed"
			? { ...state.repair, status: "pending" as const }
			: state.repair;
	const summary =
		state.phase === "summarizing" && state.summary
			? { ...state.summary, status: "pending" as const }
			: state.summary;
	// session_start 只恢复持久状态；宿主在所有 session_start handler 完成后
	// 另发 resources_discover，执行器到那个正式边界才请求推进。
	return { state: { ...state, repair, summary }, effects: [] };
}

function updateRepairStatus(
	state: ReviewState,
	expected: RepairStatus,
	status: RepairStatus,
	now: number,
): ReduceResult {
	if (state.phase !== "awaiting_fix" || state.repair?.status !== expected)
		return { state, effects: [] };
	return {
		state: { ...state, repair: { ...state.repair, status }, updatedAt: now },
		effects: [],
	};
}

function updateSummaryStatus(
	state: ReviewState,
	expected: SummaryStatus,
	status: SummaryStatus,
	now: number,
): ReduceResult {
	if (state.phase !== "summarizing" || state.summary?.status !== expected)
		return { state, effects: [] };
	return {
		state: { ...state, summary: { ...state.summary, status }, updatedAt: now },
		effects: [],
	};
}

/** 总结回合结束（或投递失败放弃）：无论何种结局都落 settled，总结是尽力而非必须。 */
function onSummarySettled(state: ReviewState, now: number): ReduceResult {
	if (state.phase !== "summarizing") return { state, effects: [] };
	return {
		state: { ...state, phase: "settled", summary: null, updatedAt: now },
		effects: [],
	};
}

/** 进入总结相的统一出口：携带意图，由 advance 在 idle 边界投递总结提示。 */
function summarizing(kind: SummaryKind): Pick<ReviewState, "phase" | "summary"> {
	return { phase: "summarizing", summary: { kind, status: "pending" } };
}

function onAdvance(
	state: ReviewState,
	limits: ReviewLimits,
	now: number,
): ReduceResult {
	if (state.phase === "queued")
		return {
			state: beginRound(state, state.focus, 1, limits, now),
			effects: [
				{
					kind: "send_card",
					card: {
						kind: "start",
						round: 1,
						focus: state.focus,
						models: limits.reviewers.map((item) => item.model),
					},
				},
				{ kind: "advance" },
			],
		};
	if (state.phase !== "awaiting_fix" || state.repair?.status !== "completed")
		return { state, effects: [] };
	if (state.round >= limits.maxRounds)
		return {
			state: { ...state, ...summarizing("max_rounds"), repair: null, updatedAt: now },
			effects: [
				{
					kind: "send_card",
					card: { kind: "stop", reason: "max_rounds", round: state.round, details: "" },
				},
				{ kind: "advance" },
			],
		};
	// 开始卡只发第 1 轮：后续轮的边界由结果卡的轮号承担，重复开始卡只制造噪声。
	return {
		state: beginRound(state, state.focus, state.round + 1, limits, now),
		effects: [{ kind: "advance" }],
	};
}

function onReviewerSettled(
	state: ReviewState,
	event: Extract<ReviewEvent, { type: "REVIEWER_SETTLED" }>,
	limits: ReviewLimits,
	now: number,
): ReduceResult {
	if (state.phase !== "reviewing" || !state.active) return { state, effects: [] };
	const active = state.active;
	const settled: ReviewerResult[] = [];
	const reviewers = active.reviewers.map((item) => {
		if (item.index !== event.index) return item;
		settled.push(event.result);
		return { ...item, status: event.result.status, result: event.result };
	});
	const settledCount = active.settledCount + 1;
	const nextActive: ActiveCheck = { ...active, reviewers, settledCount };
	if (settledCount < reviewers.length)
		return {
			state: { ...state, active: nextActive, updatedAt: now },
			effects: [],
		};
	const allSettled = nextActive.reviewers.flatMap((item) =>
		item.result ? [item.result] : [],
	);
	return settleRound(state, nextActive, allSettled, limits, now);
}

function settleRound(
	state: ReviewState,
	active: ActiveCheck,
	settled: ReviewerResult[],
	limits: ReviewLimits,
	now: number,
): ReduceResult {
	const { result, displayDetails, feedbackDetails, archiveDetails, summary } = aggregate(
		settled,
		limits.language ?? "zh",
	);
	const base = { ...state, active: null, updatedAt: now };
	const totalElapsedMs = Math.max(0, now - state.startedAt);
	const passSummary = result === "passed"
		? appendClosedFindings(summary, state.history, active.round, limits.language ?? "zh")
		: summary;
	if (result === "passed" || result === "error") {
		const round = roundRecord(active.round, result, archiveDetails, settled, undefined, state.roundStartedAt, now);
		const history = [...state.history, round];
		// 通过是质量裁决终态 → 总结回合；基础设施错误是事故 → 直接收尾。
		if (result === "passed")
			return {
				state: { ...base, ...summarizing("passed"), history },
				effects: [
					{
						kind: "send_card",
						card: {
							kind: "pass",
							round: active.round,
							summary: passSummary,
							details: archiveDetails,
							elapsedMs: round.elapsedMs,
							totalElapsedMs,
						},
					},
					{ kind: "advance" },
				],
			};
		return {
			state: { ...base, phase: "settled", history },
			effects: [
				{
					kind: "send_card",
					card: { kind: "error", message: displayDetails, elapsedMs: round.elapsedMs, totalElapsedMs },
				},
			],
		};
	}
	const consecutiveFailures = state.consecutiveFailures + 1;
	if (active.round >= limits.maxRounds) {
		const round = roundRecord(active.round, "failed", archiveDetails, settled, undefined, state.roundStartedAt, now);
		return {
			state: {
				...base,
				...summarizing("max_rounds"),
				consecutiveFailures,
				history: [...state.history, round],
			},
			effects: [
				{
					kind: "send_card",
					card: {
						kind: "stop",
						reason: "max_rounds",
						round: active.round,
						details: displayDetails,
						elapsedMs: round.elapsedMs,
					},
				},
				{ kind: "advance" },
			],
		};
	}
	// 每轮未通过都发一张可见的失败卡：用户要能看到本轮结论，
	// 而不是只收到一条投给执行模型的隐藏反馈。
	const failCard: ReviewEffect = {
		kind: "send_card",
		card: {
			kind: "fail",
			round: active.round,
			details: displayDetails,
			advisor: null,
			elapsedMs: Math.max(0, now - state.roundStartedAt),
			totalElapsedMs,
		},
	};
	const pending: PendingRound = { round: active.round, reviewers: settled, details: feedbackDetails };
	if (consecutiveFailures >= limits.advisorAfterFailures)
		return {
			state: { ...base, phase: "needs_fix", pending, consecutiveFailures },
			// 顾问可能裁定 stop，反馈永远不会投递：此时不能提前宣布「已交回修复」；
			// 卡里也不写「顾问介入中」——持久记录会过时，实况由活动条与状态栏承担。
			effects: [failCard, { kind: "advance" }],
		};
	return {
		state: {
			...base,
			phase: "awaiting_fix",
			pending: null,
			repair: { details: feedbackDetails, advisor: null, status: "pending" },
			consecutiveFailures,
			history: [
				...state.history,
				roundRecord(active.round, "failed", archiveDetails, settled, undefined, state.roundStartedAt, now),
			],
		},
		effects: [failCard, { kind: "advance" }],
	};
}

function onAdvisorSettled(
	state: ReviewState,
	event: Extract<ReviewEvent, { type: "ADVISOR_SETTLED" }>,
	limits: ReviewLimits,
	now: number,
): ReduceResult {
	if (state.phase !== "needs_fix" || !state.pending) return { state, effects: [] };
	const pending = state.pending;
	const advisor = event.result;
	const displayDetails = aggregateDetails(pending.reviewers, limits.language ?? "zh");
	if (advisor.verdict === "stop") {
		const round = roundRecord(pending.round, "stopped", advisor.advice, pending.reviewers, advisor, state.roundStartedAt, now);
		return {
			state: { ...state, ...summarizing("advisor_stop"), pending: null, history: [...state.history, round], updatedAt: now },
			effects: [
				{
					kind: "send_card",
					card: {
						kind: "stop",
						reason: "advisor",
						round: pending.round,
						// findings 已在咨询前的失败卡显示；终止卡只承载顾问裁决，避免重复整张报告。
						details: advisor.advice,
						advisor,
						advisorModel: limits.advisorModel,
						// 与顾问建议卡同一语义：咨询时长，不是轮时长（轮时长已在咨询前的失败卡显示）。
						elapsedMs: Math.max(0, now - state.updatedAt),
						totalElapsedMs: Math.max(0, now - state.startedAt),
					},
				},
				{ kind: "advance" },
			],
		};
	}
	const round = roundRecord(pending.round, "failed", pending.details, pending.reviewers, advisor, state.roundStartedAt, now);
	return {
		state: {
			...state,
			phase: "awaiting_fix",
			pending: null,
			repair: { details: pending.details, advisor, status: "pending" },
			history: [...state.history, round],
			updatedAt: now,
		},
		// 失败卡已在咨询前发出；咨询完成只补 pi-flow 的中性顾问建议卡。
		effects: [
			{
			kind: "send_card",
			// 咨询时长：needs_fix 相内只有顾问事件会迁移，updatedAt 即进入咨询的时刻。
			card: {
				kind: "advisor",
				advisor,
				advisorModel: limits.advisorModel,
				elapsedMs: Math.max(0, now - state.updatedAt),
			},
		},
			{ kind: "advance" },
		],
	};
}

function onAdvisorSkipped(state: ReviewState, now: number): ReduceResult {
	if (state.phase !== "needs_fix" || !state.pending) return { state, effects: [] };
	const pending = state.pending;
	const round = roundRecord(
		pending.round,
		"failed",
		pending.details,
		pending.reviewers,
		undefined,
		state.roundStartedAt,
		now,
	);
	return {
		state: {
			...state,
			phase: "awaiting_fix",
			pending: null,
			repair: { details: pending.details, advisor: null, status: "pending" },
			history: [...state.history, round],
			updatedAt: now,
		},
		effects: [{ kind: "advance" }],
	};
}

function onCancel(
	state: ReviewState,
	reason: "user" | "shutdown",
	now: number,
): ReduceResult {
	if (state.phase === "idle" || state.phase === "settled")
		return { state, effects: [] };
	// 总结相被取消/退出：质量裁决与结果卡已落地，静默收尾，不追加轮记录不发卡。
	if (state.phase === "summarizing") return onSummarySettled(state, now);
	if (state.phase === "queued")
		return {
			state: { ...state, phase: "settled", updatedAt: now },
			effects: [{ kind: "send_card", card: { kind: "cancel", round: 0, reason } }],
		};
	const round = resolveRoundRecord(state, "cancelled", reason, now);
	return {
		state: {
			...state,
			phase: "settled",
			active: null,
			pending: null,
			repair: null,
			history: round ? [...state.history, round] : state.history,
			updatedAt: now,
		},
		effects: [{ kind: "send_card", card: { kind: "cancel", round: state.round, reason } }],
	};
}

function onInfrastructureError(
	state: ReviewState,
	details: string,
	now: number,
): ReduceResult {
	if (state.phase === "idle" || state.phase === "settled") return { state, effects: [] };
	if (state.phase === "summarizing") return onSummarySettled(state, now);
	const message = details.trim() || "review infrastructure unavailable";
	const reviewers = state.active?.reviewers.flatMap((item) => item.result ? [item.result] : [])
		?? state.pending?.reviewers
		?? [];
	const round = state.round > 0
		? roundRecord(state.round, "error", message, reviewers, undefined, state.roundStartedAt, now)
		: undefined;
	return {
		state: {
			...state,
			phase: "settled",
			active: null,
			pending: null,
			repair: null,
			history: round ? [...state.history, round] : state.history,
			updatedAt: now,
		},
		effects: [{ kind: "send_card", card: { kind: "error", message } }],
	};
}

function onTimeout(state: ReviewState, now: number): ReduceResult {
	if (state.phase === "idle" || state.phase === "settled")
		return { state, effects: [] };
	// 看门狗在总结相到点：裁决已落地，静默收尾不误报超时。
	if (state.phase === "summarizing") return onSummarySettled(state, now);
	if (state.phase === "queued")
		return {
			state: { ...state, phase: "settled", updatedAt: now },
			effects: [{ kind: "send_card", card: { kind: "timeout", round: 0, reason: "timeout" } }],
		};
	const round = resolveRoundRecord(state, "timed_out", "timeout", now);
	return {
		state: {
			...state,
			phase: "settled",
			active: null,
			pending: null,
			repair: null,
			history: round ? [...state.history, round] : state.history,
			updatedAt: now,
		},
		effects: [
			{ kind: "send_card", card: { kind: "timeout", round: state.round, reason: "timeout" } },
		],
	};
}

function beginRound(
	state: ReviewState,
	focus: string,
	round: number,
	limits: ReviewLimits,
	now: number,
): ReviewState {
	const reviewers: ActiveReviewer[] = limits.reviewers.map((item, index) => ({
		index,
		model: item.model,
		thinking: item.thinking,
		status: "running",
		result: null,
	}));
	return {
		...state,
		phase: "reviewing",
		round,
		focus,
		active: { round, reviewers, settledCount: 0 },
		pending: null,
		repair: null,
		summary: null,
		roundStartedAt: now,
		updatedAt: now,
	};
}

/** 展示保留每个模型分节；修复反馈只携带 FAIL 票，归档保留全部原文。 */
function aggregate(
	reviewers: ReviewerResult[],
	language: "zh" | "en",
): {
	result: "passed" | "failed" | "error";
	displayDetails: string;
	feedbackDetails: string;
	archiveDetails: string;
	summary: string;
} {
	const failed = reviewers.filter((item) => item.status === "failed");
	const errors = reviewers.filter((item) => item.status === "error");
	const archiveDetails = aggregateDetails(reviewers, language);
	const fatalErrors = errors.filter((item) => !isFormatError(item.details));
	// 只忽略明确的格式错误票；任何真实基础设施错误都阻止形成质量结论，
	// 即使同轮已有 FAIL，也不能把未完整形成的审查误报为 Review Failed。
	if (fatalErrors.length > 0)
		return {
			result: "error",
			displayDetails: aggregateDetails(fatalErrors, language),
			feedbackDetails: "",
			archiveDetails,
			summary: "",
		};
	if (failed.length > 0)
		return {
			result: "failed",
			displayDetails: archiveDetails,
			feedbackDetails: aggregateDetails(failed, language),
			archiveDetails,
			summary: "",
		};
	const passed = reviewers.filter((item) => item.status === "passed");
	if (passed.length === 0)
		return {
			result: "error",
			displayDetails: aggregateDetails(errors, language),
			feedbackDetails: "",
			archiveDetails,
			summary: "",
		};
	return {
		result: "passed",
		displayDetails: archiveDetails,
		feedbackDetails: "",
		archiveDetails,
		summary: aggregatePassSummary(passed, language),
	};
}

function isFormatError(details: string) {
	return details.startsWith("审查输出格式无效") || details.startsWith("review output format invalid");
}

function aggregateDetails(reviewers: ReviewerResult[], language: "zh" | "en"): string {
	return reviewers
		.map((item) => `${modelLabel(item, language)}\n${item.details.trim()}`)
		.join("\n\n");
}

function aggregatePassSummary(reviewers: ReviewerResult[], language: "zh" | "en") {
	const fallback = language === "en" ? "Review passed." : "审查通过。";
	if (reviewers.length === 1) {
		const reviewer = reviewers[0];
		const body = passBody(reviewer?.summary ?? "") || fallback;
		const suggestions = splitSuggestions(reviewer?.details ?? "").suggestions;
		if (suggestions.length === 0) return body;
		return [
			body,
			"",
			language === "en" ? "## Suggestions (non-blocking)" : "## 建议（非阻塞）",
			...suggestions.map((item) => `- ${item}`),
		].join("\n");
	}
	const parts = reviewers.map((item) => ({
		body: item.summary,
		suggestions: splitSuggestions(item.details).suggestions,
	}));
	const lines = parts.map((part, index) =>
		`• ${shortModel(reviewers[index]?.model ?? "")}${language === "en" ? ": " : "："}${passBody(part.body) || fallback}`,
	);
	const suggestions = [...new Set(parts.flatMap((part) => part.suggestions))];
	if (suggestions.length === 0) return lines.join("\n");
	return [
		...lines,
		"",
		language === "en" ? "## Suggestions (non-blocking)" : "## 建议（非阻塞）",
		...suggestions.map((item) => `- ${item}`),
	].join("\n");
}

function splitSuggestions(summary: string) {
	const lines = summary.split(/\r?\n/u);
	const index = lines.findIndex((line) => /^##\s*(?:建议（非阻塞）|Suggestions \(non-blocking\))/iu.test(line.trim()));
	if (index < 0) return { body: summary, suggestions: [] as string[] };
	return {
		body: lines.slice(0, index).join("\n"),
		suggestions: lines.slice(index + 1).map((line) => line.replace(/^[-*]\s*/u, "").trim()).filter(Boolean),
	};
}

function passBody(summary: string) {
	return summary.replace(/^(?:PASS\s*)/iu, "").trim();
}

function shortModel(model: string) {
	return model.split("/").at(-1) || model;
}

function appendClosedFindings(
	summary: string,
	history: ReviewRound[],
	beforeRound: number,
	language: "zh" | "en",
) {
	const seen = new Set<string>();
	const findings: { round: number; issue: string }[] = [];
	for (const round of history) {
		if (round.round >= beforeRound || round.result !== "failed") continue;
		for (const line of round.details.split(/\r?\n/u)) {
			const match = /^[-*+]\s*(?:\*\*)?(?:问题|Issue)(?:\*\*)?\s*[:：]\s*(.+)$/iu.exec(line.trim());
			const issue = match?.[1]?.replace(/`([^`]+)`/gu, "$1").trim();
			if (!issue) continue;
			const key = issue.replace(/\s+/gu, "");
			if (seen.has(key)) continue;
			seen.add(key);
			findings.push({ round: round.round, issue });
		}
	}
	if (findings.length === 0) return summary;
	const shown = findings.slice(0, 6);
	const recap = [
		language === "en" ? "**Issues closed in this check**:" : "**本次收口的问题**：",
		...shown.map((finding) =>
			`• ${finding.issue}${language === "en" ? ` (Round ${finding.round})` : `（第 ${finding.round} 轮）`}`,
		),
	];
	if (findings.length > shown.length)
		recap.push(language === "en"
			? `…and ${findings.length - shown.length} more; see the review report`
			: `…另有 ${findings.length - shown.length} 项，详见审查报告`);
	return `${summary}\n\n${recap.join("\n")}`;
}

function modelLabel(item: ReviewerResult, language: "zh" | "en") {
	const model = item.model.split("/").at(-1) || item.model;
	return `${language === "en" ? "Model" : "模型"} ${item.index + 1} · ${model}`;
}

function resolveRoundRecord(
	state: ReviewState,
	result: RoundResult,
	reason: StopReason,
	now: number,
): ReviewRound | undefined {
	if (state.phase === "reviewing" && state.active) {
		const settled = state.active.reviewers.flatMap((item) =>
			item.result ? [item.result] : [],
		);
		return roundRecord(state.active.round, result, "", settled, undefined, state.roundStartedAt, now, reason);
	}
	if (state.phase === "needs_fix" && state.pending)
		return roundRecord(
			state.pending.round,
			result,
			"",
			state.pending.reviewers,
			undefined,
			state.roundStartedAt,
			now,
			reason,
		);
	return undefined;
}

function roundRecord(
	round: number,
	result: RoundResult,
	details: string,
	reviewers: ReviewerResult[],
	advisor: AdvisorResult | undefined,
	roundStartedAt: number,
	now: number,
	reason?: StopReason,
): ReviewRound {
	return {
		round,
		result,
		details,
		reviewers,
		...(advisor ? { advisor } : {}),
		...(reason ? { reason } : {}),
		elapsedMs: roundStartedAt ? Math.max(0, now - roundStartedAt) : 0,
	};
}
