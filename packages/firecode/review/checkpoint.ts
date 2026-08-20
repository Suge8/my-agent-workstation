/**
 * /fire-review 的持久化：custom entry（不进 LLM 上下文）存 reducer 状态快照。
 *
 * 零外部依赖：schema 用纯函数一次性整体校验（结构不符直接丢弃，不做字段级兼容），
 * 不引入 typebox——firecode 单目录自封闭，运行时无 node_modules，不能在扩展里声明生产依赖。
 *
 * 写入分两档：
 * - beginCheckpoint：新审查首次写入，无条件替换旧终态；
 * - writeCheckpoint：后续写入带 Run ID CAS——期望值由调用方（controller）记住的
 *   上一次写入值提供，出现不是自己写的 Run ID 才算冲突（CheckpointConflictError）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	ActiveCheck,
	ActiveReviewer,
	AdvisorResult,
	PendingRound,
	RepairState,
	ReviewRound,
	ReviewState,
	ReviewerResult,
	SummaryState,
} from "./state.js";

export const CHECKPOINT_TYPE = "firecode-review-checkpoint";
const VERSION = 5;

/** 写入凭证：同一场审查内 Run ID 不变，靠单调递增的 seq 识别陈旧写者。 */
export interface CheckpointStamp {
	runId: string;
	seq: number;
}

export class CheckpointConflictError extends Error {
	constructor() {
		super("fire-review checkpoint Run ID 已失效");
		this.name = "CheckpointConflictError";
	}
}

/** 只读会话访问（checkpoint 读/写前的 CAS 读取）。 */
export interface CheckpointReadContext {
	sessionManager?: {
		getBranch?: () => unknown[];
		getEntries?: () => unknown[];
	};
}

const PHASES = new Set([
	"idle",
	"queued",
	"reviewing",
	"needs_fix",
	"awaiting_fix",
	"summarizing",
	"settled",
]);
const ROUND_RESULTS = new Set([
	"passed",
	"failed",
	"error",
	"stopped",
	"cancelled",
	"timed_out",
]);
const REVIEWER_STATUSES = new Set(["running", "passed", "failed", "error"]);
const ADVISOR_VERDICTS = new Set(["continue", "stop", "narrow"]);
const STOP_REASONS = new Set([
	"advisor",
	"max_rounds",
	"user",
	"shutdown",
	"timeout",
]);
const REPAIR_STATUSES = new Set(["pending", "awaiting_start", "running", "completed"]);
const SUMMARY_KINDS = new Set(["passed", "max_rounds", "advisor_stop"]);
const SUMMARY_STATUSES = new Set(["pending", "awaiting_start", "running"]);

/**
 * 键白名单由领域类型派生：satisfies 要求逐字段列全，
 * state.ts 增删字段而此处未同步时编译失败——手写校验漂移的唯一防线。
 */
function keysOf<T extends Record<string, true>>(map: T): string[] {
	return Object.keys(map);
}

const REVIEWER_RESULT_KEYS = keysOf({
	index: true,
	model: true,
	thinking: true,
	status: true,
	summary: true,
	details: true,
} satisfies Record<keyof ReviewerResult, true>);

const ACTIVE_REVIEWER_KEYS = keysOf({
	index: true,
	model: true,
	thinking: true,
	status: true,
	result: true,
} satisfies Record<keyof ActiveReviewer, true>);

const ACTIVE_CHECK_KEYS = keysOf({
	round: true,
	reviewers: true,
	settledCount: true,
} satisfies Record<keyof ActiveCheck, true>);

const ADVISOR_KEYS = keysOf({
	verdict: true,
	advice: true,
} satisfies Record<keyof AdvisorResult, true>);

const ROUND_KEYS = keysOf({
	round: true,
	result: true,
	details: true,
	reviewers: true,
	advisor: true,
	reason: true,
	elapsedMs: true,
} satisfies Record<keyof ReviewRound, true>);

const PENDING_ROUND_KEYS = keysOf({
	round: true,
	reviewers: true,
	details: true,
} satisfies Record<keyof PendingRound, true>);

const REPAIR_KEYS = keysOf({
	details: true,
	advisor: true,
	status: true,
} satisfies Record<keyof RepairState, true>);

const SUMMARY_KEYS = keysOf({
	kind: true,
	status: true,
} satisfies Record<keyof SummaryState, true>);

const CHECKPOINT_KEYS = keysOf({
	version: true,
	seq: true,
	runId: true,
	phase: true,
	round: true,
	focus: true,
	history: true,
	active: true,
	pending: true,
	repair: true,
	summary: true,
	consecutiveFailures: true,
	startedAt: true,
	roundStartedAt: true,
	updatedAt: true,
} satisfies Record<keyof ReviewState | "version" | "seq", true>);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isNonNegativeInt(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function oneOf(value: unknown, allowed: ReadonlySet<string>): value is string {
	return isString(value) && allowed.has(value);
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(record).every((key) => keys.includes(key));
}

function isValidReviewerResult(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (!isNonNegativeInt(value.index) || !hasOnlyKeys(value, REVIEWER_RESULT_KEYS))
		return false;
	return (
		isString(value.model) &&
		isString(value.thinking) &&
		oneOf(value.status, REVIEWER_STATUSES) &&
		value.status !== "running" &&
		isString(value.summary) &&
		isString(value.details)
	);
}

function isValidActiveReviewer(value: unknown): boolean {
	if (!isRecord(value) || !isNonNegativeInt(value.index)) return false;
	if (!hasOnlyKeys(value, ACTIVE_REVIEWER_KEYS)) return false;
	return (
		isString(value.model) &&
		isString(value.thinking) &&
		oneOf(value.status, REVIEWER_STATUSES) &&
		(value.result === null || isValidReviewerResult(value.result))
	);
}

function isValidActiveCheck(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (!hasOnlyKeys(value, ACTIVE_CHECK_KEYS)) return false;
	const round = value.round;
	const settledCount = value.settledCount;
	if (!isNonNegativeInt(round) || !isNonNegativeInt(settledCount)) return false;
	return (
		round >= 1 &&
		Array.isArray(value.reviewers) &&
		value.reviewers.every(isValidActiveReviewer) &&
		value.reviewers.length > 0 &&
		settledCount <= value.reviewers.length
	);
}

function isValidAdvisor(value: unknown): boolean {
	if (!isRecord(value) || !hasOnlyKeys(value, ADVISOR_KEYS)) return false;
	return oneOf(value.verdict, ADVISOR_VERDICTS) && isString(value.advice);
}

function isValidRound(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (!hasOnlyKeys(value, ROUND_KEYS)) return false;
	return (
		isNonNegativeInt(value.round) &&
		oneOf(value.result, ROUND_RESULTS) &&
		isString(value.details) &&
		Array.isArray(value.reviewers) &&
		value.reviewers.every(isValidReviewerResult) &&
		(value.advisor === undefined || isValidAdvisor(value.advisor)) &&
		(value.reason === undefined || oneOf(value.reason, STOP_REASONS)) &&
		isNonNegativeInt(value.elapsedMs)
	);
}

function isValidPendingRound(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (!hasOnlyKeys(value, PENDING_ROUND_KEYS)) return false;
	const round = value.round;
	return (
		isNonNegativeInt(round) &&
		round >= 1 &&
		Array.isArray(value.reviewers) &&
		value.reviewers.every(isValidReviewerResult) &&
		isString(value.details)
	);
}

function isValidRepair(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, REPAIR_KEYS) &&
		isString(value.details) &&
		(value.advisor === null || isValidAdvisor(value.advisor)) &&
		oneOf(value.status, REPAIR_STATUSES)
	);
}

function isValidSummary(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, SUMMARY_KEYS) &&
		oneOf(value.kind, SUMMARY_KINDS) &&
		oneOf(value.status, SUMMARY_STATUSES)
	);
}

/** 一次性整体校验 checkpoint；结构或版本不符返回 false（调用方直接丢弃）。 */
export function isValidCheckpoint(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (!hasOnlyKeys(value, CHECKPOINT_KEYS)) return false;
	if (!isNonNegativeInt(value.seq) || value.seq < 1) return false;
	return (
		value.version === VERSION &&
		isString(value.runId) &&
		oneOf(value.phase, PHASES) &&
		isNonNegativeInt(value.round) &&
		isString(value.focus) &&
		Array.isArray(value.history) &&
		value.history.every(isValidRound) &&
		(value.active === null || isValidActiveCheck(value.active)) &&
		(value.pending === null || isValidPendingRound(value.pending)) &&
		(value.repair === null || isValidRepair(value.repair)) &&
		(value.summary === null || isValidSummary(value.summary)) &&
		isNonNegativeInt(value.consecutiveFailures) &&
		isNonNegativeInt(value.startedAt) &&
		isNonNegativeInt(value.roundStartedAt) &&
		isNonNegativeInt(value.updatedAt)
	);
}

function toCheckpoint(state: ReviewState) {
	return {
		version: VERSION,
		runId: state.runId,
		phase: state.phase,
		round: state.round,
		focus: state.focus,
		history: state.history,
		active: state.active,
		pending: state.pending,
		repair: state.repair,
		summary: state.summary,
		consecutiveFailures: state.consecutiveFailures,
		startedAt: state.startedAt,
		roundStartedAt: state.roundStartedAt,
		updatedAt: state.updatedAt,
	};
}

/** 读当前分支上最近一个 checkpoint；无、损坏或版本不匹配都返回 undefined。 */
export function readCheckpoint(ctx: CheckpointReadContext): ReviewState | undefined {
	const entry = latestEntry(ctx);
	return entry ? (entry as unknown as ReviewState) : undefined;
}

function latestEntry(ctx: CheckpointReadContext): Record<string, unknown> | undefined {
	const entries =
		ctx.sessionManager?.getBranch?.() ??
		ctx.sessionManager?.getEntries?.() ??
		[];
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!isRecord(entry) || entry.type !== "custom") continue;
		if (entry.customType !== CHECKPOINT_TYPE) continue;
		if (!isValidCheckpoint(entry.data)) return undefined;
		return entry.data as Record<string, unknown>;
	}
	return undefined;
}

/** 读最近一条 checkpoint 的写入凭证；无则 null。 */
export function readStamp(ctx: CheckpointReadContext): CheckpointStamp | null {
	const entry = latestEntry(ctx);
	if (!entry) return null;
	const data = entry as { runId: string; seq: number };
	return { runId: data.runId, seq: data.seq };
}

function appendCheckpoint(
	pi: ExtensionAPI,
	state: ReviewState,
	seq: number,
): CheckpointStamp {
	const data = { ...toCheckpoint(state), seq };
	if (!isValidCheckpoint(data)) throw new Error("fire-review checkpoint 状态非法");
	pi.appendEntry(CHECKPOINT_TYPE, data);
	return { runId: state.runId, seq };
}

/** 新审查首次写入：无条件替换旧终态（不校验旧 Run ID）。 */
/** 新审查首写：无条件替换旧终态，返回本次写入凭证。 */
export function beginCheckpoint(
	pi: ExtensionAPI,
	_ctx: CheckpointReadContext,
	state: ReviewState,
): CheckpointStamp {
	return appendCheckpoint(pi, state, 1);
}

/**
 * 后续写入时当前持久化凭证必须与 controller 记住的上一次完全一致。
 * 只比 Run ID 不够——同一场审查被两个运行时同时恢复时 Run ID 相同，
 * 靠 seq 才能识别出陈旧写者并拒绝静默覆盖。
 */
export function writeCheckpoint(
	pi: ExtensionAPI,
	ctx: CheckpointReadContext,
	state: ReviewState,
	expected: CheckpointStamp,
): CheckpointStamp {
	const current = readStamp(ctx);
	if (
		!current ||
		current.runId !== expected.runId ||
		current.seq !== expected.seq
	)
		throw new CheckpointConflictError();
	return appendCheckpoint(pi, state, expected.seq + 1);
}
