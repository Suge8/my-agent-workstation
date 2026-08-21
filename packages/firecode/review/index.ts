/**
 * /fire-review：对抗性审查插件的执行器与入口。
 *
 * 职责分界：
 * - 领域状态只活在纯 reducer（state.ts）里，所有迁移经 reduce() 计算；
 *   本文件是唯一执行器，只做副作用（起子进程、投递反馈、发卡、持久化、状态栏），
 *   子进程结果一律回灌成事件交给 reducer。模块级只有一个 controller。
 * - 渲染器在此顶层无条件注册（不懒加载），live 与 reload 外观一致。
 */
import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, type Language, type ReviewConfig } from "../config.js";
import { formatDuration } from "../format.js";
import { herdrPaneEnv, herdrRequest } from "../herdr-client.js";
import { buildCard, CARD_TYPE, decisionText, registerCardRenderer } from "./card.js";
import {
	beginCheckpoint,
	CHECKPOINT_TYPE,
	CheckpointConflictError,
	type CheckpointStamp,
	readCheckpoint,
	readStamp,
	writeCheckpoint,
} from "./checkpoint.js";
import { buildEvidence } from "./evidence.js";
import {
	applyProcessEvent,
	initialProgress,
	type ReviewerProgress,
	settleProgress,
} from "./progress.js";
import {
	type ActivityView,
	hideActivity,
	lockEditor,
	showActivity,
	unlockEditor,
} from "./ui.js";
import { REVIEW_OCCUPANCY_LABEL as OCCUPANCY_LABEL } from "./outcome.js";
import { buildAdvisorPrompt, buildFixFeedback, buildReviewPrompt, buildSummaryPrompt, readPrompt } from "./prompt.js";
import { runAdvisor } from "./advisor.js";
import { runReviewer, type ReviewModelConfig } from "./reviewer.js";
import {
	type AdvisorResult,
	type CardData,
	type ReviewEffect,
	type ReviewEvent,
	type ReviewLimits,
	type ReviewState,
	initialState,
	reduce,
} from "./state.js";

export const FEEDBACK_TYPE = "firecode-review-feedback";
/** 总结回合提示：与修复反馈同通道（进上下文不渲染），不参与证据自指。 */
export const SUMMARY_REQUEST_TYPE = "firecode-review-summary";
const STATUS_KEY = "fire-review";
const OCCUPANCY_CHANNEL = "herdr:blocked";
const OCCUPANCY_SOURCE = "firecode-review";
/** herdr 按 seq 丢弃过期上报；同一 source 单调递增。 */
let occupancySeq = Date.now() * 1000;
/** 标签租约：TTL 要容得下至少两次续约失败，否则瞬断会让 Master 误读。 */
const OCCUPANCY_TTL_MS = 60_000;
const OCCUPANCY_REFRESH_MS = 20_000;
/** sendMessage 没有 Promise/错误回调；用 agent_start 作为反馈已启动的回执。 */
const FEEDBACK_START_TIMEOUT_MS = 2_000;
/** 总体超时：maxRounds 轮 × 每轮 2 倍单进程超时，最低 30 分钟。 */
function overallTimeoutMs(config: ReviewConfig) {
	return Math.max(
		30 * 60_000,
		config.maxRounds * config.timeoutMinutes * 2 * 60_000,
	);
}

function isActive(state: ReviewState) {
	return (
		state.phase === "queued" ||
		state.phase === "reviewing" ||
		state.phase === "needs_fix" ||
		state.phase === "awaiting_fix" ||
		// 总结回合仍属审查生命周期：占用标签持有到总结完成，Master 才不会在
		// 结果卡与总结之间的窗口提前结算、漏掉总结回复。
		state.phase === "summarizing"
	);
}

interface Controller {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	config: ReviewConfig;
	state: ReviewState;
	signal: AbortController;
	watchdog: ReturnType<typeof setTimeout> | undefined;
	statusTimer?: ReturnType<typeof setInterval>;
	/** 本 controller 上一次写入的凭证；null=本审查还没写过，undefined=冲突/失败后停写。 */
	persistedStamp: CheckpointStamp | null | undefined;
	/** streaming 时 sendMessage 会变成 steer；展示卡必须等 settled 后再发。 */
	pendingCards: CardData[];
	/** 本运行时已启动的阶段；reload 后新 controller 会重新启动被中断的子进程。 */
	runningAction?: string;
	/** 当前审查者/顾问任务；执行模型 agent_start 必须 await 它退出后才能继续。 */
	actionPromise?: Promise<void>;
	actionController?: AbortController;
	/** 反馈 sendMessage 已调用，等待 agent_start 回执。 */
	feedbackStartTimer?: ReturnType<typeof setTimeout>;
	/** 子进程实时进度：纯 UI 态，高频更新，不入 checkpoint。 */
	progress: readonly ReviewerProgress[];
	/** 当前 progress 属于审查者还是顾问：修复相据此决定是否展示裁决摘要。 */
	progressKind?: "reviewers" | "advisor";
	progressStartedAt?: number;
	/** 编辑器是否已被审查接管（禁输入 + esc 取消）。 */
	editorLocked?: boolean;
	/** Herdr blocked 频道采用计数语义，每个 true 必须由同一 controller 配对 false。 */
	occupancyHeld?: boolean;
	/** 占用标签租约续期计时器；释放与 shutdown 时清除。 */
	occupancyTimer?: ReturnType<typeof setInterval>;
}

let controller: Controller | undefined;
let dispatchQueue: Promise<void> = Promise.resolve();

export function registerReview(pi: ExtensionAPI, enabled = true, configBroken = false): void {
	// 渲染器与开关解耦：关闭 review 后历史卡 reload 仍使用原生结果卡样式。
	registerCardRenderer(pi);
	if (!enabled) {
		// 只有用户明确关闭才封存活动 checkpoint（防重新启用后恢复幽灵审查）；
		// features 配置坏掉不是关闭：保留 checkpoint，修好配置重启后继续恢复。
		if (!configBroken) pi.on("session_start", (_event, ctx) => settleDisabledCheckpoint(pi, ctx));
		return;
	}
	pi.registerCommand("fire-review", {
		description: "对抗性审查：审这个会话到目前为止做完的事",
		handler: (args, ctx) => handleCommand(pi, args, ctx),
	});
	pi.on("session_start", (_event, ctx) => handleSessionStart(pi, ctx));
	// 宿主保证 resources_discover 在整次 session_start（含所有异步 handler）完成后发出。
	pi.on("resources_discover", (_event, ctx) => requestAdvance(pi, ctx));
	pi.on("agent_start", () => handleAgentStart(pi));
	// agent_end 只记录修复/总结回合的结局，不在此推进审查。
	pi.on("agent_end", (event) => handleAgentEnd(pi, event));
	// settled 后尝试恢复；后续异步 handler 若再触发模型，agent_start 互锁会先停审查。
	pi.on("agent_settled", (_event, ctx) => scheduleAfterAgentSettled(pi, ctx));
	pi.on("session_shutdown", (event, ctx) => handleShutdown(pi, event.reason, ctx));
}

function settleDisabledCheckpoint(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const checkpoint = readCheckpoint(ctx);
	if (!checkpoint || !isActive(checkpoint)) return;
	settleUnavailableCheckpoint(pi, ctx, checkpoint);
}

function settleUnavailableCheckpoint(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	checkpoint: ReviewState,
): void {
	try {
		beginCheckpoint(pi, ctx, {
			...checkpoint,
			phase: "settled",
			active: null,
			pending: null,
			repair: null,
			summary: null,
			updatedAt: Date.now(),
		});
	} catch (error) {
		if (ctx.hasUI)
			ctx.ui.notify(`fire-review 无法收口旧 checkpoint：${errorText(error)}`, "error");
	}
}

/** 串行化状态迁移：reducer 同步执行，副作用排队；同一时刻只有一个迁移在跑。
 * 返回队尾 Promise，让 pi 的事件处理器（session_shutdown 等）可 await 持久化落盘。 */
function dispatch(pi: ExtensionAPI, event: ReviewEvent): Promise<void> {
	const run = dispatchQueue.then(async () => {
		if (!controller || controller.pi !== pi) return;
		const { state, effects } = reduce(
			controller.state,
			event,
			limitsOf(controller.config),
			Date.now(),
		);
		if (state !== controller.state) {
			controller.state = state;
			// 持久化失败不能当成功继续：否则会拿不一致的状态去起子进程、投反馈，
			// 重启后又从旧 checkpoint 恢复，重现幽灵审查与重复反馈。
			const persisted = persist(pi, state);
			if (!persisted) return;
			syncOccupancy(controller);
			syncUi();
		}
		await runEffects(effects);
	});
	// 队列一旦 rejected 就再也不会执行后续迁移（连 esc 取消也会失效）：
	// 副作用异常只能到此为止，不得杀死状态机。
	dispatchQueue = run.catch((error) => {
		notifyEffectFailure(error);
	});
	return dispatchQueue;
}

function notifyEffectFailure(error: unknown) {
	const active = controller;
	if (!active?.ctx.hasUI) return;
	const message = error instanceof Error ? error.message : String(error);
	active.ctx.ui.notify(
		active.config.language === "en"
			? `fire-review step failed: ${message}`
			: `fire-review 步骤失败：${message}`,
		"warning",
	);
}

/**
 * 读 review 配置；存在配置问题就不交出可用配置。
 * 命令与恢复两个入口共用：任何一个静默回退默认模型都会花真钱跑错模型。
 */
function loadReviewConfig(): { config: ReviewConfig } | { error: string } {
	let loaded: ReturnType<typeof loadConfig>;
	try {
		loaded = loadConfig();
	} catch (error) {
		return {
			error: `fire-review 配置读取失败：${error instanceof Error ? error.message : String(error)}`,
		};
	}
	// 两类都必须阻断：文件整体解析不了（此时 review 节根本没被读到），以及 review 节自身有错。
	// 三类都必须阻断：文件整体解析不了、review 节自身有错、
	// 以及 features.review 开关类型错（字符串 "false" 会因 `!== false` 静默启用付费审查）。
	const problems = loaded.problems.filter(
		(problem) =>
			problem.startsWith("review") ||
			problem.startsWith("未知字段 review.") ||
			problem.startsWith("config.jsonc") ||
			problem.startsWith("features"),
	);
	if (problems.length > 0)
		return { error: `fire-review 配置有问题，已停止：${problems.join("；")}` };
	if (!loaded.config.review.advisor.model || loaded.config.review.reviewers.length === 0)
		return { error: "fire-review 配置有问题，已停止：请显式完整配置 review" };
	return { config: loaded.config.review };
}

function limitsOf(config: ReviewConfig): ReviewLimits {
	return {
		maxRounds: config.maxRounds,
		advisorAfterFailures: config.advisorAfterFailures,
		advisorModel: config.advisor.model,
		language: config.language,
		reviewers: config.reviewers.map((item) => ({
			model: item.model,
			thinking: item.thinking,
		})),
	};
}

async function handleCommand(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionContext,
) {
	// 配置解析失败不能让命令无声失败：pi 会捕获 handler 异常，用户只会看到什么都没发生。
	const loaded = loadReviewConfig();
	if ("error" in loaded) {
		ctx.ui.notify(loaded.error, "error");
		return;
	}
	const config = loaded.config;
	if (!ctx.hasUI) {
		ctx.ui.notify(
			config.language === "en"
				? "Adversarial review requires the TUI."
				: "对抗性审查需要交互式界面。",
			"info",
		);
		return;
	}
	if (controller && isActive(controller.state)) {
		ctx.ui.notify(
			config.language === "en"
				? "A review is already running."
				: "已有审查在进行中。",
			"info",
		);
		return;
	}
	// 旧审查的看门狗必须在覆盖 controller 前停掉：它的回调读的是全局 controller，
	// 否则旧超时到点时会把新一场审查中止。
	clearWatchdog();
	const command = parseCommand(args, config.language);
	if ("error" in command) {
		ctx.ui.notify(command.error, "error");
		return;
	}
	controller = {
		pi,
		ctx,
		config,
		state: initialState(randomUUID()),
		signal: new AbortController(),
		watchdog: undefined,
		persistedStamp: null,
		pendingCards: [],
		progress: initialProgress(config.reviewers, config.language),
	};
	armWatchdog();
	armStatusTimer();
	// 命令入口也只提出推进请求；真正开审统一经过下一 event-loop 的 idle barrier.
	void dispatch(pi, {
		type: "START",
		focus: command.focus,
		busy: true,
	});
}

/** 重启 / 会话恢复：从 checkpoint 重建 controller 并续跑未完成的环节。
 * reload / new / resume / fork 是运行时替换（新 pi），先清掉旧 controller，
 * 再按新会话的 checkpoint 恢复；quit 之外不 settle，审查能在重启后继续。 */
function handleSessionStart(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> | void {
	if (controller && controller.pi !== pi) {
		setOccupancy(controller, false);
		controller = undefined;
	}
	const checkpoint = readCheckpoint(ctx);
	if (!checkpoint || !isActive(checkpoint)) {
		if (controller && !isActive(controller.state)) controller = undefined;
		return;
	}
	if (controller && isActive(controller.state)) return;
	const loaded = loadReviewConfig();
	if ("error" in loaded) {
		if (ctx.hasUI) ctx.ui.notify(loaded.error, "error");
		// 配置问题只阻止本次恢复；保留活动 checkpoint，修好配置并重启后可继续。
		return;
	}
	const config = loaded.config;
	clearWatchdog();
	controller = {
		pi,
		ctx,
		config,
		state: checkpoint,
		signal: new AbortController(),
		watchdog: undefined,
		persistedStamp: readStamp(ctx),
		pendingCards: [],
		progress: initialProgress(config.reviewers, config.language),
	};
	armWatchdog();
	armStatusTimer();
	syncOccupancy(controller);
	syncUi();
	// 恢复只更新持久状态并提出推进请求；绝不在 session_start handler 内起任何工作。
	return dispatch(pi, { type: "RECOVER" });
}

async function handleAgentStart(pi: ExtensionAPI): Promise<void> {
	const active = controller;
	if (!active || active.pi !== pi) return;
	if (
		active.state.phase === "awaiting_fix" &&
		active.state.repair?.status === "awaiting_start"
	) {
		clearFeedbackStartTimer(active);
		await dispatch(pi, { type: "REPAIR_STARTED" });
		return;
	}
	if (
		active.state.phase === "summarizing" &&
		active.state.summary?.status === "awaiting_start"
	) {
		clearFeedbackStartTimer(active);
		await dispatch(pi, { type: "SUMMARY_STARTED" });
		return;
	}
	// 其他扩展可在我们排队后异步触发执行模型。agent_start 是宿主提供的硬边界：
	// 宿主会 await 本 handler，因此先 abort 并等所有审查子进程真正退出，再允许模型 turn_start。
	if (!active.actionPromise) return;
	active.actionController?.abort();
	await active.actionPromise;
	if (controller !== active || !isActive(active.state)) return;
	active.runningAction = undefined;
	active.actionPromise = undefined;
}

function handleAgentEnd(
	pi: ExtensionAPI,
	event: { messages: readonly unknown[] },
): Promise<void> | void {
	const active = controller;
	if (!active || active.pi !== pi) return;
	// 总结回合任何结局都收尾：裁决已落地，总结失败/中断不重试不升级。
	if (active.state.phase === "summarizing" && active.state.summary?.status === "running")
		return dispatch(pi, { type: "SUMMARY_SETTLED" });
	if (
		active.state.phase !== "awaiting_fix" ||
		active.state.repair?.status !== "running"
	) return;
	const assistant = [...event.messages]
		.reverse()
		.find((message) => isRecord(message) && message.role === "assistant");
	if (isRecord(assistant) && assistant.stopReason !== "error" && assistant.stopReason !== "aborted")
		return dispatch(pi, { type: "REPAIR_COMPLETED" });
	active.signal.abort();
	return dispatch(pi, { type: "CANCEL", reason: "user" });
}

function scheduleAfterAgentSettled(pi: ExtensionAPI, ctx: ExtensionContext): void {
	requestAdvance(pi, ctx);
}

function requestAdvance(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const active = controller;
	if (!active || active.pi !== pi) return;
	const runId = active.state.runId;
	void advanceWhenIdle(pi, ctx, runId).catch((error) => {
		notifyEffectFailure(error);
		if (controller !== active) return;
		active.signal.abort();
		void dispatch(pi, { type: "CANCEL", reason: "user" });
	});
}

async function advanceWhenIdle(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runId: string,
): Promise<void> {
	const active = controller;
	// 所有启动入口共享 idle 门；正确性另由 agent_start 的同步停审互锁保证。
	if (
		!active ||
		active.pi !== pi ||
		active.state.runId !== runId ||
		active.signal.signal.aborted ||
		!ctx.isIdle() ||
		ctx.hasPendingMessages()
	) return;
	active.ctx = ctx;
	flushPendingCards(pi);
	const { state } = active;
	if (state.phase === "queued") {
		await dispatch(pi, { type: "ADVANCE" });
		return;
	}
	if (state.phase === "reviewing") {
		startAction(active, `review:${state.round}`, "reviewer", () => startReviewers(pi));
		return;
	}
	if (state.phase === "needs_fix") {
		startAction(active, `advisor:${state.round}`, "advisor", () => consultAdvisor(pi));
		return;
	}
	if (state.phase === "summarizing") {
		if (state.summary?.status !== "pending") return;
		await dispatch(pi, { type: "SUMMARY_DISPATCHED" });
		const current = controller?.state;
		if (controller === active && current?.phase === "summarizing" && current.summary?.status === "awaiting_start")
			deliverSummaryNow(pi, current);
		return;
	}
	if (state.phase !== "awaiting_fix" || !state.repair) return;
	if (state.repair.status === "pending") {
		await dispatch(pi, { type: "FEEDBACK_DISPATCHED" });
		const repair = controller?.state.repair;
		if (controller === active && repair?.status === "awaiting_start")
			deliverFeedbackNow(pi, repair.details, repair.advisor);
		return;
	}
	if (state.repair.status === "completed") await dispatch(pi, { type: "ADVANCE" });
}

function startAction(
	active: Controller,
	key: string,
	kind: "reviewer" | "advisor",
	run: () => Promise<void>,
): void {
	if (active.runningAction === key) return;
	active.runningAction = key;
	active.actionController = new AbortController();
	const action = run()
		.catch(async (error) => {
			if (controller !== active || active.actionController?.signal.aborted) return;
			await dispatch(active.pi, {
				type: "INFRASTRUCTURE_ERROR",
				details: processErrorText(kind, active.config.language, error),
			});
		})
		.finally(() => {
			if (active.actionPromise !== action) return;
			active.actionPromise = undefined;
			active.actionController = undefined;
			active.runningAction = undefined;
		});
	active.actionPromise = action;
}

async function handleShutdown(
	pi: ExtensionAPI,
	reason: "quit" | "reload" | "new" | "resume" | "fork",
	ctx: ExtensionContext,
): Promise<void> {
	const active = controller;
	if (!active) return;
	// 会话离开当前运行时就立即释放；reload 恢复会由新 controller 重新配对喊占用。
	setOccupancy(active, false);
	// 无论何种终止都先杀子进程并等 close；旧进程不得泄漏到新运行时。
	active.signal.abort();
	active.actionController?.abort();
	clearWatchdog();
	clearStatusTimer(active);
	clearFeedbackStartTimer(active);
	await active.actionPromise;
	if (active.ctx !== ctx) active.ctx = ctx;
	if (reason === "quit") {
		await dispatch(pi, { type: "CANCEL", reason: "shutdown" });
		return;
	}
	// reload / new / resume / fork 保留 checkpoint，由新运行时在 post-session 边界恢复。
	hideActivity(active.ctx);
	releaseEditor(active);
	await dispatchQueue;
}

function armWatchdog() {
	if (!controller) return;
	clearWatchdog();
	const elapsed = controller.state.startedAt
		? Math.max(0, Date.now() - controller.state.startedAt)
		: 0;
	const remaining = Math.max(0, overallTimeoutMs(controller.config) - elapsed);
	if (remaining === 0) {
		controller.signal.abort();
		void dispatch(controller.pi, { type: "TIMEOUT" });
		return;
	}
	controller.watchdog = setTimeout(() => {
		const active = controller;
		if (!active || !isActive(active.state)) return;
		active.signal.abort();
		active.actionController?.abort();
		dispatch(active.pi, { type: "TIMEOUT" });
	}, remaining);
	controller.watchdog.unref?.();
}

function clearWatchdog() {
	if (controller?.watchdog) clearTimeout(controller.watchdog);
}

function armStatusTimer() {
	const active = controller;
	if (!active || active.statusTimer) return;
	// 耗时显示本身就是定时业务语义；宿主没有可订阅的“整秒变化”事件。
	active.statusTimer = setInterval(() => {
		if (controller !== active || !isActive(active.state)) return;
		renderStatus(active.ctx, active.state, active.config.language);
	}, 1_000);
	active.statusTimer.unref?.();
}

function clearStatusTimer(active: Controller) {
	if (active.statusTimer) clearInterval(active.statusTimer);
	active.statusTimer = undefined;
}

function clearFeedbackStartTimer(active: Controller): void {
	if (active.feedbackStartTimer) clearTimeout(active.feedbackStartTimer);
	active.feedbackStartTimer = undefined;
}

// ---- 持久化与状态栏（状态的投影）----

/** 返回是否已可靠落盘；false 时调用方必须停下本次迁移的副作用。 */
function persist(pi: ExtensionAPI, state: ReviewState): boolean {
	if (!controller) return false;
	const persisted = controller.persistedStamp;
	if (persisted === undefined) return false; // 冲突或写入失败后停写
	try {
		controller.persistedStamp =
			persisted === null
				? beginCheckpoint(pi, controller.ctx, state)
				: writeCheckpoint(pi, controller.ctx, state, persisted);
		return true;
	} catch (error) {
		if (error instanceof CheckpointConflictError) {
			// 持久化里出现不是本 controller 写的 Run ID：并发冲突，停止审查。
			setOccupancy(controller, false);
			controller.persistedStamp = undefined;
			controller.signal.abort();
			controller.actionController?.abort();
			controller.ctx.ui.notify(
				controller.config.language === "en"
					? "fire-review checkpoint conflict; review stopped."
					: "fire-review checkpoint 冲突，已停止审查。",
				"warning",
			);
			void dispatch(pi, { type: "CANCEL", reason: "shutdown" });
			return false;
		}
		// 普通写入失败（如会话落盘异常）：停掉本场审查，不带着不一致状态继续跑。
		setOccupancy(controller, false);
		controller.persistedStamp = undefined;
		controller.signal.abort();
		controller.actionController?.abort();
		if (controller.ctx.hasUI)
			controller.ctx.ui.notify(
				controller.config.language === "en"
					? `fire-review checkpoint write failed; review stopped: ${errorText(error)}`
					: `fire-review checkpoint 写入失败，已停止审查：${errorText(error)}`,
				"error",
			);
		releaseEditor(controller);
		hideActivity(controller.ctx);
		// 磁盘上可能还留着上一条活动 checkpoint，重启会把它恢复成幽灵审查：
		// 尽力补写一条终态。写不进去时不假装成功，在通知里告知用户。
		let sealed = true;
		try {
			beginCheckpoint(pi, controller.ctx, {
				...state,
				phase: "settled",
				active: null,
				pending: null,
				repair: null,
				summary: null,
			});
		} catch {
			sealed = false;
		}
		// 内存态也必须释放：只停子进程但留着活动态 controller，会把幽灵审查从磁盘搬到内存——
		// 后续命令永远被「已有审查在进行中」挡住，且无处取消。
		clearWatchdog();
		clearStatusTimer(controller);
		clearFeedbackStartTimer(controller);
		const uiCtx = controller.ctx;
		const language = controller.config.language;
		if (uiCtx.hasUI) uiCtx.ui.setStatus(STATUS_KEY, undefined);
		controller = undefined;
		if (!sealed && uiCtx.hasUI)
			uiCtx.ui.notify(
				language === "en"
					? "fire-review could not seal the checkpoint; a restart may resume this review — cancel it with esc."
					: "fire-review 无法写入终态，重启后可能恢复这场审查，到时按 esc 取消。",
				"warning",
			);
		return false;
	}
}

function errorText(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function syncOccupancy(active: Controller): void {
	setOccupancy(active, isActive(active.state));
}

/**
 * 标签租约：持有期带 TTL 定时续约，释放时清除失败重试一次、再失败由 TTL 到期兜底。
 * 定时续约是租约业务语义：herdr 没有“进程退出即清 metadata”的接口（源码核实），
 * crash/kill 后无 TTL 的标签永驻会让 Master 把 Worker 的真提问误判为审查占用；
 * 续约同时充当首次投递失败的重试。
 */
function publishOccupancyLabel(active: Controller, held: boolean): void {
	if (held) {
		void sendOccupancyLabel();
		if (!active.occupancyTimer) {
			active.occupancyTimer = setInterval(() => void sendOccupancyLabel(), OCCUPANCY_REFRESH_MS);
			active.occupancyTimer.unref?.();
		}
		return;
	}
	if (active.occupancyTimer) {
		clearInterval(active.occupancyTimer);
		active.occupancyTimer = undefined;
	}
	void clearOccupancyLabel();
}

function sendOccupancyLabel(): Promise<boolean> {
	const env = herdrPaneEnv();
	if (!env) return Promise.resolve(false);
	return herdrRequest(OCCUPANCY_SOURCE, "pane.report_metadata", {
		pane_id: env.paneId,
		source: OCCUPANCY_SOURCE,
		state_labels: { blocked: OCCUPANCY_LABEL },
		ttl_ms: OCCUPANCY_TTL_MS,
		seq: (occupancySeq += 1),
	});
}

async function clearOccupancyLabel(): Promise<void> {
	const env = herdrPaneEnv();
	if (!env) return;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		// 新审查已重新持有时中止重试：迟到的清除会撤掉新租约的标签。
		if (controller?.occupancyHeld) return;
		const delivered = await herdrRequest(OCCUPANCY_SOURCE, "pane.report_metadata", {
			pane_id: env.paneId,
			source: OCCUPANCY_SOURCE,
			clear_state_labels: true,
			seq: (occupancySeq += 1),
		});
		if (delivered) return;
	}
	// 两次未送达：标签带 TTL，最迟 60s 自行过期，不会永久残留。
}

function setOccupancy(active: Controller, held: boolean): void {
	if (Boolean(active.occupancyHeld) === held) return;
	active.occupancyHeld = held;
	// 标签走 metadata state_labels：herdr 会丢弃 report_agent 的 message（实测），
	// 只有这条通道能同时到达 Master（state_labels 判定）与侧边栏（state_text token）。
	// 频道仍要发：它驱动 herdr 集成的 blocked 状态本身。占用信号不伤审查。
	publishOccupancyLabel(active, held);
	try {
		active.pi.events.emit(OCCUPANCY_CHANNEL, {
			active: held,
			...(held ? { label: OCCUPANCY_LABEL } : {}),
		});
	} catch (error) {
		// 占用信号只对齐 Herdr 展示；集成故障不能改变审查状态机或子进程生命周期。
		try {
			if (active.ctx.hasUI)
				active.ctx.ui.notify(`fire-review 无法同步 Herdr 占用状态：${errorText(error)}`, "warning");
		} catch {
			// 通知本身同样只是展示，不能反向打断审查。
		}
	}
}

/**
 * UI 投影：状态栏一行 + 编辑器上方活动条 + esc 接管，全部从当前状态派生。
 * 活动条自己按帧重绘，因此进度变化不需要在这里通知。
 */
function syncUi(): void {
	const active = controller;
	if (!active) return;
	renderStatus(active.ctx, active.state, active.config.language);
	if (activityView()) {
		showActivity(active.ctx, activityView);
		// 只在等模型结论时接管编辑器；awaiting_fix 相把输入交还用户。
		if (canCancelWithKey()) {
			if (!active.editorLocked) {
				lockEditor(active.ctx, activityView, cancelByUser);
				active.editorLocked = true;
			}
		} else releaseEditor(active);
		return;
	}
	clearStatusTimer(active);
	hideActivity(active.ctx);
	releaseEditor(active);
}

function releaseEditor(active: Controller) {
	if (!active.editorLocked) return;
	unlockEditor(active.ctx);
	active.editorLocked = false;
}

/** 活动条快照；非活动相与总结回合返回 undefined（总结是普通可见回合，不需要活动框）。 */
function activityView(): ActivityView | undefined {
	const active = controller;
	if (!active || !isActive(active.state) || active.state.phase === "summarizing" || !active.ctx.hasUI) return undefined;
	return {
		phase: active.state.phase,
		round: active.state.round,
		focus: active.state.focus,
		roundStartedAt: active.state.roundStartedAt,
		progressStartedAt: active.progressStartedAt,
		reviewers: active.progress,
		progressKind: active.progressKind,
		advisorRunning: active.state.phase === "needs_fix",
		consecutiveFailures: active.state.consecutiveFailures,
		cwd: active.ctx.cwd,
		language: active.config.language,
	};
}

function canCancelWithKey() {
	const phase = controller?.state.phase;
	return phase === "queued" || phase === "reviewing" || phase === "needs_fix";
}

function cancelByUser() {
	const active = controller;
	if (!active) return;
	if (active.state.phase === "needs_fix") {
		// pi-flow 语义：顾问阶段的 Esc 只跳过本次咨询，不取消整场审查。
		active.actionController?.abort();
		void (active.actionPromise ?? Promise.resolve()).then(() =>
			dispatch(active.pi, { type: "ADVISOR_SKIPPED" }),
		);
		return;
	}
	active.signal.abort();
	active.actionController?.abort();
	void dispatch(active.pi, { type: "CANCEL", reason: "user" });
}

function renderStatus(
	ctx: ExtensionContext,
	state: ReviewState,
	language: Language,
) {
	if (!ctx.hasUI) return;
	let prefix: string | undefined;
	if (state.phase === "queued")
		prefix = language === "en"
			? "🔥 running · review when done"
			: "🔥 执行中 · 完成后自动审查";
	else if (state.phase === "reviewing" || state.phase === "needs_fix")
		prefix = `🔥 ${roundStatus(state.round, language === "en" ? "review" : "审查", language)}`;
	else if (state.phase === "awaiting_fix")
		prefix = `🔥 ${roundStatus(state.round, language === "en" ? "repair" : "修复中", language)}`;
	else if (state.phase === "summarizing")
		prefix = language === "en" ? "🔥 summarizing" : "🔥 总结中";
	if (!prefix) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const stepStartedAt = state.phase === "awaiting_fix"
		? state.updatedAt
		: state.roundStartedAt || state.startedAt;
	const stepMs = stepStartedAt ? Date.now() - stepStartedAt : 0;
	const totalMs = state.startedAt ? Date.now() - state.startedAt : 0;
	const showTotal = state.round > 1 || state.history.some((round) => round.result === "failed");
	const elapsed = showTotal
		? `${formatDuration(stepMs)} / ${language === "en" ? "total" : "总"} ${formatDuration(totalMs)}`
		: formatDuration(stepMs);
	ctx.ui.setStatus(STATUS_KEY, `${prefix} · ${elapsed}`);
}


function roundStatus(round: number, phase: string, language: Language) {
	if (round <= 1) return phase;
	return language === "en" ? `Round ${round} ${phase}` : `第 ${round} 轮${phase}`;
}

// ---- 副作用执行器 ----

/** reducer 只发卡或请求推进；所有会启动工作的动作统一经过 idle barrier。 */
async function runEffects(effects: ReviewEffect[]) {
	for (const effect of effects) {
		const active = controller;
		if (!active) return;
		if (effect.kind === "advance") {
			requestAdvance(active.pi, active.ctx);
			continue;
		}
		try {
			sendCard(active.pi, effect.card);
		} catch (error) {
			notifyEffectFailure(error);
		}
	}
}

function reviewerModelConfig(model: { model: string; thinking: string }, config: ReviewConfig): ReviewModelConfig {
	return {
		model: model.model,
		thinking: model.thinking,
		command: config.background.command,
		tools: config.tools,
		timeoutMs: config.timeoutMinutes * 60_000,
	};
}

/** 开审那一刻取会话分支快照构造 prompt，所有审查者共用同一 prompt。 */
async function startReviewers(pi: ExtensionAPI): Promise<void> {
	const active = controller;
	if (!active) return;
	const { state, config } = active;
	if (!state.active) return;
	const currentActive = state.active;
	const actionSignal = active.actionController?.signal ?? active.signal.signal;
	active.progressStartedAt = Date.now();
	active.progressKind = "reviewers";
	active.progress = initialProgress(
		currentActive.reviewers.map((item) => ({ model: item.model })),
		config.language,
	);
	for (const reviewer of currentActive.reviewers)
		if (reviewer.status !== "running" && reviewer.result)
			active.progress = settleProgress(
				active.progress,
				reviewer.index,
				reviewer.status,
				config.language,
				reviewer.result.summary,
				reviewer.result.details,
			);
	const evidence = buildEvidence(sessionEntries(), config.language);
	const prompt = buildReviewPrompt(readPrompt("review", config.language), {
		language: config.language,
		scope: scopeText(config.language),
		focus: state.focus,
		evidence: evidence.text,
		history: state.history,
		round: state.round,
	});
	const tasks = currentActive.reviewers
		.filter((reviewer) => reviewer.status === "running")
		.map(async (reviewer) => {
			try {
				const result = await runReviewer({
					index: reviewer.index,
					config: reviewerModelConfig(reviewer, config),
					prompt,
					cwd: active.ctx.cwd,
					language: config.language,
					signal: actionSignal,
					onEvent: (event) => {
						if (controller !== active) return;
						active.progress = applyProcessEvent(
							active.progress,
							reviewer.index,
							event,
							config.language,
						);
					},
				});
				if (controller === active)
					active.progress = settleProgress(
						active.progress,
						result.index,
						result.status,
						config.language,
						result.summary,
						result.details,
					);
				if (!actionSignal.aborted)
					await dispatch(pi, { type: "REVIEWER_SETTLED", index: result.index, result });
			} catch (error) {
				if (actionSignal.aborted) return;
				await dispatch(pi, {
					type: "REVIEWER_SETTLED",
					index: reviewer.index,
					result: {
						index: reviewer.index,
						model: reviewer.model,
						thinking: reviewer.thinking,
						status: "error",
						summary: "",
						details: processErrorText("reviewer", active.config.language, error),
					},
				});
			}
		});
	await Promise.all(tasks);
}

async function consultAdvisor(pi: ExtensionAPI): Promise<void> {
	const active = controller;
	if (!active) return;
	const { state, config } = active;
	if (!state.pending) return;
	const pending = state.pending;
	const actionSignal = active.actionController?.signal ?? active.signal.signal;
	active.progressStartedAt = Date.now();
	active.progressKind = "advisor";
	active.progress = initialProgress([{ model: config.advisor.model }], config.language);
	const prompt = buildAdvisorPrompt(readPrompt("advisor", config.language), {
		language: config.language,
		focus: state.focus,
		details: pending.details,
		history: state.history,
		round: pending.round,
	});
	try {
		const result = await runAdvisor({
			config: reviewerModelConfig(config.advisor, config),
			prompt,
			cwd: active.ctx.cwd,
			language: config.language,
			signal: actionSignal,
			onEvent: (event) => {
				if (controller !== active) return;
				active.progress = applyProcessEvent(active.progress, 0, event, config.language);
			},
		});
		if (controller === active)
			active.progress = settleProgress(
				active.progress,
				0,
				"passed",
				config.language,
				advisorSummary(result, config.language),
				result.advice,
			);
		if (!actionSignal.aborted)
			await dispatch(pi, { type: "ADVISOR_SETTLED", result });
	} catch (error) {
		if (actionSignal.aborted) return;
		await dispatch(pi, {
			type: "INFRASTRUCTURE_ERROR",
			details: processErrorText("advisor", active.config.language, error),
		});
	}
}

/** 顾问落定后的一行摘要：裁决 + 「下一步方向」首句，与审查者摘要同一展示通道。
 * 建议正文以「核实结论」段开头，直取首行只会露出段标题星号，预览零信息量。 */
function advisorSummary(result: AdvisorResult, language: Language) {
	const label = decisionText(result.verdict, language);
	const first = adviceHighlight(result.advice);
	if (!first) return label;
	return language === "en" ? `${label}: ${first}` : `${label}：${first}`;
}

const NEXT_DIRECTION_LABEL = /^\*{0,2}(?:下一步方向|Next direction)\*{0,2}\s*[:：]\s*/iu;

function adviceHighlight(advice: string) {
	const lines = advice.split(/\r?\n/u);
	const index = lines.findIndex((line) => NEXT_DIRECTION_LABEL.test(line.trim()));
	const source = index >= 0
		? [lines[index].trim().replace(NEXT_DIRECTION_LABEL, ""), ...lines.slice(index + 1)]
		: lines;
	const first = source.map(stripBold).find((line) => line.trim())?.trim() ?? "";
	return first.replace(/^[-*+]\s*/u, "").trim();
}

function stripBold(text: string) {
	return text.replace(/\*\*([^*]+)\*\*/gu, "$1");
}

function processErrorText(kind: "reviewer" | "advisor", language: Language, error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	if (kind === "reviewer")
		return language === "en" ? `reviewer subprocess error: ${message}` : `审查子进程异常：${message}`;
	return language === "en" ? `advisor subprocess error: ${message}` : `顾问子进程异常：${message}`;
}

function deliverFeedbackNow(
	pi: ExtensionAPI,
	details: string,
	advisor: AdvisorResult | null,
) {
	const active = controller;
	if (!active || active.pi !== pi) return;
	const feedback = buildFixFeedback({
		language: active.config.language,
		details,
		advisor,
	});
	clearFeedbackStartTimer(active);
	// API 返回 void，真实异步失败不会进 try/catch；持久化状态等待 agent_start 回执。
	active.feedbackStartTimer = setTimeout(() => {
		if (
			controller !== active ||
			active.state.phase !== "awaiting_fix" ||
			active.state.repair?.status !== "awaiting_start"
		) return;
		active.feedbackStartTimer = undefined;
		if (active.ctx.hasUI)
			active.ctx.ui.notify(
				active.config.language === "en"
					? "fire-review feedback did not start a repair turn; review stopped."
					: "fire-review 修复反馈未能启动回合，审查已停止。",
				"error",
			);
		active.signal.abort();
		void dispatch(pi, { type: "CANCEL", reason: "user" });
	}, FEEDBACK_START_TIMEOUT_MS);
	active.feedbackStartTimer.unref?.();
	// display:false 的消息进 LLM 上下文但不渲染；triggerTurn 让执行模型开始修复回合。
	try {
		pi.sendMessage(
			{ customType: FEEDBACK_TYPE, content: feedback, display: false },
			{ deliverAs: "followUp", triggerTurn: true },
		);
	} catch (error) {
		clearFeedbackStartTimer(active);
		throw error;
	}
}

/** 总结提示投递：与修复反馈同一套 agent_start 回执机制；失败不升级，静默收尾。 */
function deliverSummaryNow(pi: ExtensionAPI, state: ReviewState): void {
	const active = controller;
	if (!active || active.pi !== pi || !state.summary) return;
	const last = state.history.at(-1);
	const material = state.summary.kind === "advisor_stop"
		? last?.advisor?.advice ?? last?.details ?? ""
		: last?.details ?? "";
	const prompt = buildSummaryPrompt({
		language: active.config.language,
		kind: state.summary.kind,
		rounds: state.history.length,
		material,
	});
	clearFeedbackStartTimer(active);
	active.feedbackStartTimer = setTimeout(() => {
		if (
			controller !== active ||
			active.state.phase !== "summarizing" ||
			active.state.summary?.status !== "awaiting_start"
		) return;
		active.feedbackStartTimer = undefined;
		// 总结是尽力而非必须：未能启动回合就静默收尾，裁决与结果卡已落地。
		if (active.ctx.hasUI)
			active.ctx.ui.notify(
				active.config.language === "en"
					? "fire-review summary turn did not start; finishing without it."
					: "fire-review 总结回合未能启动，已直接收尾。",
				"warning",
			);
		void dispatch(pi, { type: "SUMMARY_SETTLED" });
	}, FEEDBACK_START_TIMEOUT_MS);
	active.feedbackStartTimer.unref?.();
	try {
		pi.sendMessage(
			{ customType: SUMMARY_REQUEST_TYPE, content: prompt, display: false },
			{ deliverAs: "followUp", triggerTurn: true },
		);
	} catch (error) {
		clearFeedbackStartTimer(active);
		notifyEffectFailure(error);
		void dispatch(pi, { type: "SUMMARY_SETTLED" });
	}
}

function sendCard(pi: ExtensionAPI, card: CardData) {
	if (!controller) return;
	// pi-flow 的用户取消是即时临时通知，不进会话；shutdown 静默收口。
	if (card.kind === "cancel") {
		if (card.reason === "user")
			controller.ctx.ui.notify(
				controller.config.language === "en"
					? "⏸ Review cancelled\nStopped by user"
					: "⏸ 审查已取消\n已按你的操作停止",
				"info",
			);
		return;
	}
	// 宿主在 streaming 时会把无 options 的 sendMessage 当 steer 塞进当前模型回合。
	// 卡片只是 UI 投影，绝不能因此唤醒或打断执行模型。
	if (!controller.ctx.isIdle()) {
		controller.pendingCards.push(card);
		return;
	}
	sendCardNow(pi, card);
}

function flushPendingCards(pi: ExtensionAPI): void {
	const active = controller;
	if (!active || !active.ctx.isIdle() || active.pendingCards.length === 0) return;
	const cards = active.pendingCards.splice(0);
	for (const card of cards) {
		try {
			sendCardNow(pi, card);
		} catch (error) {
			notifyEffectFailure(error);
		}
	}
}

function sendCardNow(pi: ExtensionAPI, card: CardData): void {
	if (!controller) return;
	const built = buildCard(card, controller.config.language);
	pi.sendMessage({
		customType: CARD_TYPE,
		content: built.content,
		display: true,
		details: built.details,
	});
}

function parseCommand(args: string, language: Language): { focus: string } | { error: string } {
	const input = args.trim();
	return input.startsWith("--")
		? { error: language === "en" ? "Invalid fire-review arguments." : "fire-review 参数无效" }
		: { focus: input };
}

/** 会话分支 entries（供证据组装）；本插件的卡与反馈消息不参与证据，避免自指。 */
function sessionEntries() {
	const manager = controller?.ctx.sessionManager as
		| { getBranch?: () => unknown[] }
		| undefined;
	const entries = manager?.getBranch?.() ?? [];
	return entries.filter(
		(entry) =>
			!isRecord(entry) ||
			entry.type !== "custom_message" ||
			(entry.customType !== CARD_TYPE && entry.customType !== FEEDBACK_TYPE &&
				entry.customType !== SUMMARY_REQUEST_TYPE),
	);
}

function scopeText(language: Language) {
	return language === "en"
		? "Delivery quality of the current task in this conversation. The first user message is the original-request anchor; later user messages may override, narrow, or correct it."
		: "当前会话当前任务的交付质量。首条用户消息是原始需求锚点；后续用户消息可能覆盖、缩小或修正，以后者为准。";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 导出供测试用（纯函数 / 类型）
export { CHECKPOINT_TYPE };

/** 测试专用：等待 event-loop barrier 与其产生的状态迁移排空。 */
export async function __reviewFlushForTests(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	await dispatchQueue;
	await new Promise<void>((resolve) => setImmediate(resolve));
	await dispatchQueue;
}
