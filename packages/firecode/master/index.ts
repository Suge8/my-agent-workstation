import { statSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	isToolCallEventType,
	ModelRuntime,
	type AgentSession,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { MASTER_ROLES, loadConfig, type MasterModelAtom, type MasterRole } from "../config.js";
import { deliver } from "../deliver.js";
import { formatDuration } from "../format.js";
import { readReviewOutcome, type ReviewOutcome } from "../review/outcome.js";
import { ToolLine, makeResultRenderer } from "../tools/line.js";
import type { Part } from "../tools/parts.js";
import { registerMasterEventRenderer } from "./event-card.js";
import { MASTER_EVENT_TYPE, masterEventDetails, sectionLine } from "./event-format.js";
import { assembleMasterPrompt, assembleWorkerPrompt, readMasterPrompt } from "./prompt.js";
import { InProcessSessionPool, preallocateWorkerSession } from "./spawn.js";
import {
	MasterStore,
	THINKING_LEVELS,
	recoverMasterState,
	loadMasterState,
	masterStatePath,
	requireWorker,
	type MasterState,
	type WorkerRef,
	type WorkerStatus,
} from "./state.js";

const MASTER_TOOL = "subagents";
const MASTER_LIST_TOOL = "subagents_list";
const MASTER_TOOLS = [MASTER_TOOL, MASTER_LIST_TOOL];
const WORKER_TOOLS = ["read", "bash", "edit", "write"];
const PENDING_EVENT_TYPE = "firecode-master-pending-event";
const EVENT_ACK_TYPE = "firecode-master-event-ack";
const EVENT_RETRY_MS = 5_000;

interface PendingMasterEvent {
	id: string;
	content: string;
	worker?: string;
}

interface MasterDependencies {
	resolveModel?: (id: string) => Promise<Model<any>>;
	pool?: InProcessSessionPool;
	interruptResumeMs?: number;
}

interface CurrentTool {
	tool: string;
	startedAt: number;
}

interface ReviewProgress {
	kind: "review";
	round: number;
	settled: number;
	total: number;
}

interface WorkerTerminal {
	text: string;
	stopReason?: string;
	errorMessage?: string;
}

interface ObservedSession {
	session: AgentSession;
	unsubscribe: () => void;
}

interface MasterRuntime {
	ctx: ExtensionContext;
	store: MasterStore;
	pool: InProcessSessionPool;
	events: PendingMasterEvent[];
	currentTools: Map<string, Map<string, CurrentTool>>;
	idleSince: Map<string, number>;
	reviewProgress: Map<string, ReviewProgress>;
	observedSessions: Map<string, ObservedSession>;
	flushTimer?: NodeJS.Timeout;
}

export function registerMaster(
	pi: ExtensionAPI,
	dependencies: MasterDependencies = {},
	worker = false,
): void {
	if (worker) {
		pi.on("tool_call", async (event, ctx) => {
			if (!isToolCallEventType("edit", event) && !isToolCallEventType("write", event)) return;
			const reason = await outsideCheckoutReason(event.input.path, ctx.cwd);
			if (reason) return { block: true, reason };
		});
		return;
	}
	let runtime: MasterRuntime | undefined;
	const loaded = loadMasterConfiguration();
	const prompts = loadMasterPrompts();
	const startupError = "error" in loaded ? loaded.error : "error" in prompts ? prompts.error : undefined;
	const roster = "error" in loaded ? [] : loaded.roles;
	const exclusions = "error" in loaded ? [] : loaded.workerExcludeExtensions;
	const autoActivate = "error" in loaded ? false : loaded.autoActivate;
	const requirePrompts = () => {
		if ("error" in prompts) throw new Error(prompts.error);
		return prompts;
	};
	const reviewGate = reviewGateError();
	const pool = dependencies.pool ?? new InProcessSessionPool();
	const activeRuns = new Map<string, symbol>();
	const interruptedRuns = new Map<string, symbol>();
	const startingNames = new Set<string>();
	const transitioningNames = new Set<string>();
	const interruptTimers = new Map<string, NodeJS.Timeout>();
	registerMasterEventRenderer(pi);

	const setTools = (active: boolean) => {
		const tools = pi.getActiveTools().filter((name) => !MASTER_TOOLS.includes(name));
		pi.setActiveTools(active ? [...tools, ...MASTER_TOOLS] : tools);
	};
	const ownsRuntime = (active: MasterRuntime): boolean => runtime === active;
	const requireRuntimeOwner = (active: MasterRuntime): void => {
		if (!ownsRuntime(active)) throw new Error("Master 会话已替换，取消旧会话动作");
	};
	let spinFrame = 0;
	let spinTimer: ReturnType<typeof setInterval> | undefined;
	/** 计时器只在活动期存活：状态变化起停，全部落定即停，无常驻轮询。 */
	const syncSpinner = (active: boolean) => {
		if (active === (spinTimer !== undefined)) return;
		if (!active) {
			clearInterval(spinTimer);
			spinTimer = undefined;
			return;
		}
		spinTimer = setInterval(() => {
			spinFrame += 1;
			renderStatus();
		}, SPINNER_MS);
		spinTimer.unref?.();
	};
	const renderStatus = () => {
		if (!runtime) return;
		const workers = runtime.store.state.workers;
		syncSpinner(masterActive(workers));
		runtime.ctx.ui.setStatus("master", masterStatusLine(workers, runtime.ctx.ui.theme, spinFrame));
	};
	const activate = (ctx: ExtensionContext, restored?: MasterState): MasterRuntime => {
		if (startupError) throw new Error(startupError);
		if (runtime) {
			runtime.ctx = ctx;
			return runtime;
		}
		let active!: MasterRuntime;
		const store = new MasterStore(masterStatePath(ctx.sessionManager.getSessionId()), restored, () => {
			if (ownsRuntime(active)) renderStatus();
		});
		active = {
			ctx,
			store,
			pool,
			events: [],
			currentTools: new Map(),
			idleSince: new Map(),
			reviewProgress: new Map(),
			observedSessions: new Map(),
		};
		runtime = active;
		setTools(true);
		if (store.discardedLegacyVersion !== undefined)
			ctx.ui.notify(`旧版 v${store.discardedLegacyVersion} 子代理池已丢弃并从空池重建；旧运行时进程不会纳入新池，请手动清理`, "warning");
		// store 创建时 runtime 尚未就位，激活完成后只补这一次首绘。
		renderStatus();
		return active;
	};
	const deactivate = () => {
		const active = runtime;
		runtime = undefined;
		pool.disposeAll();
		syncSpinner(false);
		for (const timer of interruptTimers.values()) clearTimeout(timer);
		interruptTimers.clear();
		activeRuns.clear();
		interruptedRuns.clear();
		startingNames.clear();
		transitioningNames.clear();
		if (active?.flushTimer) clearTimeout(active.flushTimer);
		for (const observed of active?.observedSessions.values() ?? []) observed.unsubscribe();
		active?.ctx.ui.setStatus("master", undefined);
		setTools(false);
	};
	const flushEvents = (active: MasterRuntime) => {
		if (!ownsRuntime(active)) return;
		active.flushTimer = undefined;
		if (!active.events.length) return;
		const batch = active.events.splice(0);
		const content = batch.map((event) => event.content).join("\n\n");
		deliver(pi, active.ctx, {
			customType: MASTER_EVENT_TYPE,
			content: masterEventEnvelope(content),
			details: masterEventDetails(batch.map((event) => event.content)),
		}).then(() => {
			if (!ownsRuntime(active)) return;
			try {
				pi.appendEntry(EVENT_ACK_TYPE, { ids: batch.map((event) => event.id) });
			} catch (error) {
				active.ctx.ui.notify(`子代理结果确认写入失败，reload 后可能重复投递：${String(error)}`, "warning");
			}
			for (const event of batch) {
				if (!event.worker) continue;
				const worker = active.store.state.workers.find((candidate) => candidate.name === event.worker);
				if (worker?.status === "idle" && worker.disposition !== "reminded")
					active.store.dispatch({ type: "UPSERT_WORKER", worker: { ...worker, disposition: "pending" } });
			}
		}, (error) => {
			if (!ownsRuntime(active)) return;
			active.events.unshift(...batch);
			active.ctx.ui.notify(`子代理结果投递失败，将自动重试：${String(error)}`, "warning");
			active.flushTimer = setTimeout(() => flushEvents(active), EVENT_RETRY_MS);
			active.flushTimer.unref?.();
		});
	};
	const enqueueEvent = (
		active: MasterRuntime,
		content: string,
		worker?: string,
		persist = true,
		id = crypto.randomUUID(),
	) => {
		if (!ownsRuntime(active)) return;
		const event: PendingMasterEvent = { id, content, ...(worker ? { worker } : {}) };
		if (persist) {
			try {
				pi.appendEntry(PENDING_EVENT_TYPE, event);
			} catch (error) {
				active.ctx.ui.notify(`子代理结果持久化失败，crash 时可能丢失：${String(error)}`, "warning");
			}
		}
		active.events.push(event);
		if (!active.flushTimer) {
			active.flushTimer = setTimeout(() => flushEvents(active), 0);
			active.flushTimer.unref?.();
		}
	};
	const clearInterruptTimer = (name: string) => {
		const timer = interruptTimers.get(name);
		if (timer) clearTimeout(timer);
		interruptTimers.delete(name);
	};
	const armInterruptReminder = (active: MasterRuntime, worker: WorkerRef) => {
		if (!ownsRuntime(active)) return;
		clearInterruptTimer(worker.name);
		const duration = dependencies.interruptResumeMs ?? 5 * 60_000;
		const delay = Math.max(0, (worker.interruptedAt ?? Date.now()) + duration - Date.now());
		const timer = setTimeout(() => {
			if (!ownsRuntime(active)) return;
			interruptTimers.delete(worker.name);
			const current = active.store.state.workers.find((candidate) => candidate.name === worker.name);
			if (!current?.interruptedAt || current.interruptedAt !== worker.interruptedAt) return;
			active.store.dispatch({ type: "UPSERT_WORKER", worker: { ...current, disposition: "reminded" } });
			enqueueEvent(active, `子代理 ${worker.name} 自动续跑提醒：上次回合被外部中断，请 send 续派或 kill 收口`, worker.name);
		}, delay);
		timer.unref?.();
		interruptTimers.set(worker.name, timer);
	};
	const activateSession = (ctx: ExtensionContext): MasterRuntime => {
		if (runtime) return activate(ctx);
		let restored: MasterState | undefined;
		try {
			restored = loadMasterState(masterStatePath(ctx.sessionManager.getSessionId()));
		} catch {
			return activate(ctx);
		}
		const active = activate(ctx, restored);
		if (restored) {
			const recovered = recoverMasterState(restored);
			for (const worker of recovered.workers) {
				if (worker !== restored.workers.find((candidate) => candidate.name === worker.name))
					active.store.dispatch({ type: "UPSERT_WORKER", worker });
				if (worker.interruptedAt) armInterruptReminder(active, worker);
			}
		}
		for (const event of unackedEvents(ctx))
			enqueueEvent(active, event.content, event.worker, false, event.id);
		return active;
	};
	const currentWorker = (active: MasterRuntime, identity: WorkerRef) => {
		requireRuntimeOwner(active);
		const current = active.store.state.workers.find((worker) => worker.name === identity.name);
		if (current?.sessionPath === identity.sessionPath) return current;
		active.pool.dispose(identity.sessionPath);
		throw new Error(`${identity.name} 已被 kill，取消本次动作`);
	};
	const openWorkerSession = async (active: MasterRuntime, worker: WorkerRef) => {
		requireRuntimeOwner(active);
		const hot = active.pool.getSession(worker.sessionPath);
		if (hot) return hot;
		const model = await (dependencies.resolveModel ?? resolveConfiguredModel)(worker.model);
		requireRuntimeOwner(active);
		const spawned = await active.pool.spawn({
			cwd: worker.cwd ?? process.cwd(),
			role: "worker",
			model,
			thinking: worker.thinking,
			tools: WORKER_TOOLS,
			excludeExtensions: exclusions,
			systemPrompt: { mode: "append", text: assembleWorkerPrompt(requirePrompts().worker, worker.name) },
			contextFiles: true,
			persistence: { type: "file", sessionPath: worker.sessionPath, resume: true },
		});
		if (!ownsRuntime(active)) {
			spawned.dispose();
			requireRuntimeOwner(active);
		}
		return spawned.session;
	};
	const observeWorker = (active: MasterRuntime, sessionPath: string, session: AgentSession) => {
		requireRuntimeOwner(active);
		const previous = active.observedSessions.get(sessionPath);
		if (previous?.session === session) return;
		previous?.unsubscribe();
		const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			if (!ownsRuntime(active)) return;
			if (event.type === "tool_execution_start") {
				const tools = active.currentTools.get(sessionPath) ?? new Map<string, CurrentTool>();
				tools.set(event.toolCallId, { tool: event.toolName, startedAt: Date.now() });
				active.currentTools.set(sessionPath, tools);
			}
			if (event.type === "tool_execution_end") {
				const tools = active.currentTools.get(sessionPath);
				tools?.delete(event.toolCallId);
				if (!tools?.size) active.currentTools.delete(sessionPath);
			}
			if (event.type === "entry_appended") {
				const progress = reviewProgressFromEntry(event.entry);
				if (progress) active.reviewProgress.set(sessionPath, progress);
			}
		});
		active.observedSessions.set(sessionPath, { session, unsubscribe });
	};
	const runWorker = (active: MasterRuntime, worker: WorkerRef, session: Awaited<ReturnType<typeof openWorkerSession>>, prompt: string) => {
		requireRuntimeOwner(active);
		observeWorker(active, worker.sessionPath, session);
		const run = Symbol(worker.name);
		let terminal: WorkerTerminal | undefined;
		activeRuns.set(worker.sessionPath, run);
		const unsubscribeTerminal = session.subscribe((event) => {
			if (!ownsRuntime(active) || activeRuns.get(worker.sessionPath) !== run || event.type !== "agent_end") return;
			terminal = captureWorkerTerminal(event.messages);
		});
		const settled = async (error?: unknown) => {
			unsubscribeTerminal();
			if (!ownsRuntime(active) || activeRuns.get(worker.sessionPath) !== run) return;
			activeRuns.delete(worker.sessionPath);
			if (interruptedRuns.get(worker.sessionPath) === run) {
				interruptedRuns.delete(worker.sessionPath);
				const current = active.store.state.workers.find((candidate) => candidate.name === worker.name);
				if (!current || current.sessionPath !== worker.sessionPath) return;
				const interrupted: WorkerRef = { ...current, status: "idle", interruptedAt: Date.now() };
				active.store.dispatch({ type: "UPSERT_WORKER", worker: interrupted });
				active.currentTools.delete(worker.sessionPath);
				active.idleSince.set(worker.sessionPath, Date.now());
				enqueueEvent(active, `子代理 ${worker.name} 已中断，会话与审查义务均已保留`, worker.name);
				armInterruptReminder(active, interrupted);
				return;
			}
			const fault = providerFaultReason(terminal);
			if (fault && error === undefined) {
				await resumeWithFallback(active, worker, session, terminal!, fault);
				return;
			}
			const content = settleWorker(active, worker, terminal, error);
			if (content) enqueueEvent(active, content, worker.name);
		};
		void session.prompt(prompt).then(() => void settled(), (error) => void settled(error));
	};
	const resumeWithFallback = async (
		active: MasterRuntime,
		identity: WorkerRef,
		session: Awaited<ReturnType<typeof openWorkerSession>>,
		terminal: WorkerTerminal,
		reason: string,
	) => {
		const current = currentWorker(active, identity);
		const configuredRole = roster.find((entry) => entry.role === current.role);
		if (!configuredRole) {
			const failure = `${terminalFailure(terminal)}\n角色 ${current.role} 已不在角色表，无法 fallback`;
			const content = settleWorker(active, current, terminal, new Error(failure));
			if (content) enqueueEvent(active, content, current.name);
			return;
		}
		const fallback = nextFallback(configuredRole, current);
		if (!fallback) {
			const failure = `${terminalFailure(terminal)}\n角色 ${current.role} 的 fallback 链已用尽`;
			const content = settleWorker(active, current, terminal, new Error(failure));
			if (content) enqueueEvent(active, content, current.name);
			return;
		}
		try {
			const model = await (dependencies.resolveModel ?? resolveConfiguredModel)(fallback.model);
			requireRuntimeOwner(active);
			await session.setModel(model);
			requireRuntimeOwner(active);
			session.setThinkingLevel(fallback.thinking);
			const latest = currentWorker(active, current);
			const switched: WorkerRef = { ...latest, ...fallback, status: "working" };
			active.store.dispatch({ type: "UPSERT_WORKER", worker: switched });
			const from = modelAtomText(current);
			const to = modelAtomText(fallback);
			enqueueEvent(active, `子代理 ${current.name} 已切换 ${from}→${to}（${reason}），正在同一会话自动续跑`, current.name);
			runWorker(active, switched, session, fallbackResumePrompt(from, to, reason));
		} catch (error) {
			const failure = `${terminalFailure(terminal)}\nfallback 切换失败：${error instanceof Error ? error.message : String(error)}`;
			const content = settleWorker(active, current, terminal, new Error(failure));
			if (content) enqueueEvent(active, content, current.name);
		}
	};

	pi.registerCommand("fire-master", {
		description: "翻转当前会话的指挥官模式；status 查看状态",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (input === "status") {
				ctx.ui.notify(runtime ? statusText(runtime.store.state.workers) : "指挥官模式未启动", "info");
				return;
			}
			if (input) {
				ctx.ui.notify("/fire-master 只接受 status；裸命令翻转开关", "error");
				return;
			}
			if (runtime) {
				deactivate();
				ctx.ui.notify("指挥官模式已关闭", "info");
				return;
			}
			try {
				activateSession(ctx);
				ctx.ui.notify("指挥官模式已启动", "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (!runtime || !pi.getActiveTools().includes(MASTER_TOOL)) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${assembleMasterPrompt(requirePrompts().master, rosterText(roster))}`,
		};
	});

	pi.registerTool({
		name: MASTER_LIST_TOOL,
		label: "子代理",
		description: "查看子代理池快照",
		renderShell: "self",
		renderCall: (_args, theme, ctx) =>
			new ToolLine({ label: "子代理", value: subagentsCallParts({ action: "list" }), clip: "end", theme, ctx }),
		renderResult: (result, options, theme, context) => {
			const details = result.details as { workers?: unknown } | undefined;
			context.state.meta = !context.isError && Array.isArray(details?.workers) ? listMeta(details.workers) : undefined;
			if (options.expanded && Array.isArray(details?.workers))
				return expandedWorkerList(details.workers, theme, context);
			return renderSubagentsResult(result, options, theme, context);
		},
		parameters: Type.Object({}),
		async execute() {
			const active = runtime;
			if (!active) throw new Error("subagents_list 只在 Master 中可用");
			const workers = active.store.state.workers.map(compactWorker);
			return {
				content: [{ type: "text" as const, text: JSON.stringify({ workers }) }],
				details: {
					workers: workers.map((worker) => ({
						...worker,
						currentAction: currentWorkerAction(active, worker),
					})),
				},
			};
		},
	});

	pi.registerTool({
		name: MASTER_TOOL,
		label: "子代理",
		description: "指挥官的七动作子代理接口：start 按角色新建，send 续派或切换角色，interrupt 中断，review 显式审查，tail 读轨迹，ack 确认落定，kill 收口移除；无 sleep/session。",
		renderShell: "self",
		renderCall: (args, theme, ctx) =>
			new ToolLine({ label: "子代理", value: subagentsCallParts(args as Record<string, unknown>), clip: "end", theme, ctx }),
		renderResult: renderSubagentsResult,
		parameters: Type.Object({
			action: StringEnum(["start", "send", "interrupt", "review", "tail", "ack", "kill"] as const, {
				description: "七动作之一；等待状态变化，不要用 sleep 轮询。",
			}),
			worker: Type.String({ description: "start 起简短任务名；其余动作填目标 Worker。" }),
			prompt: Type.Optional(Type.String({ description: "start/send 必填自包含任务说明，包括交付物、限制与验证要求。" })),
			role: Type.Optional(StringEnum(MASTER_ROLES, { description: "start 必填固定角色；send 可选，传入时切换角色，省略则沿用。" })),
			thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: "可选思考档覆盖；省略时使用角色原子档或当前档。" })),
			cwd: Type.Optional(Type.String({ description: "仅 start 可选：Worker 工作目录的绝对路径，默认当前目录。" })),
			review: Type.Optional(Type.Boolean({ description: "按审查纪律为 start/send 记录义务；true 不自动开审。" })),
		}),
		async execute(_id, params: Record<string, unknown>, _signal, _update, ctx) {
			const active = runtime;
			if (!active) throw new Error("subagents 只在 Master 中可用");
			if (params.action === "kill") {
				const target = requireWorker(active.store.state, requiredString(params.worker, "worker"));
				clearInterruptTimer(target.name);
				activeRuns.delete(target.sessionPath);
				interruptedRuns.delete(target.sessionPath);
				active.currentTools.delete(target.sessionPath);
				active.idleSince.delete(target.sessionPath);
				active.reviewProgress.delete(target.sessionPath);
				active.observedSessions.get(target.sessionPath)?.unsubscribe();
				active.observedSessions.delete(target.sessionPath);
				active.pool.dispose(target.sessionPath);
				active.store.dispatch({ type: "REMOVE_WORKER", name: target.name });
				return toolResult({ killed: true });
			}
			if (params.action === "tail") {
				const target = requireWorker(active.store.state, requiredString(params.worker, "worker"));
				return { content: [{ type: "text" as const, text: await readWorkerTrace(target) }] };
			}
			if (params.action === "ack") {
				const target = requireWorker(active.store.state, requiredString(params.worker, "worker"));
				if (target.reviewNeeded) throw new Error(`${target.name} 此票有审查义务，完成 review 后才能 ack`);
				if (target.status !== "idle") throw new Error(`${target.name} 正在 ${target.status}，不能 ack`);
				if (target.disposition) {
					const { disposition: _disposition, ...rest } = target;
					active.store.dispatch({ type: "UPSERT_WORKER", worker: rest });
				}
				return toolResult({ acked: true });
			}
			if (params.action === "review") {
				if (reviewGate) throw new Error(reviewGate);
				const target = requireWorker(active.store.state, requiredString(params.worker, "worker"));
				if (target.status !== "idle" || transitioningNames.has(target.name))
					throw new Error(`${target.name} 正在处理其他动作，不能 review`);
				transitioningNames.add(target.name);
				try {
					const session = await openWorkerSession(active, target);
					await session.waitForIdle();
					requireRuntimeOwner(active);
					observeWorker(active, target.sessionPath, session);
					const current = currentWorker(active, target);
					const previousRunId = reviewRunId(readReviewOutcome(target.sessionPath));
					const { disposition: _disposition, interruptedAt: _interruptedAt, ...rest } = current;
					clearInterruptTimer(target.name);
					const reviewing: WorkerRef = { ...rest, status: "reviewing" };
					active.idleSince.delete(target.sessionPath);
					active.store.dispatch({ type: "UPSERT_WORKER", worker: reviewing });
					void monitorReview(session, target.sessionPath, previousRunId).then(
						(outcome) => {
							if (!ownsRuntime(active)) return;
							const current = active.store.state.workers.find((worker) => worker.name === target.name);
							if (!current || current.sessionPath !== target.sessionPath || current.status !== "reviewing") return;
							const { reviewNeeded: _needed, ...fulfilled } = current;
							const worker = outcome.status === "passed" || outcome.status === "stopped"
								? fulfilled
								: current;
							active.store.dispatch({ type: "UPSERT_WORKER", worker: { ...worker, status: "idle" } });
							active.reviewProgress.delete(target.sessionPath);
							active.idleSince.set(target.sessionPath, Date.now());
							active.pool.markIdle(target.sessionPath);
							enqueueEvent(active, reviewOutcomeText(target.name, outcome, session.messages), target.name);
						},
						(error) => {
							if (!ownsRuntime(active)) return;
							const current = active.store.state.workers.find((worker) => worker.name === target.name);
							if (!current || current.status !== "reviewing") return;
							active.store.dispatch({ type: "UPSERT_WORKER", worker: { ...current, status: "idle" } });
							active.reviewProgress.delete(target.sessionPath);
							active.idleSince.set(target.sessionPath, Date.now());
							active.pool.markIdle(target.sessionPath);
							enqueueEvent(active, `子代理 ${target.name} 审查未完成：${String(error)}`, target.name);
						},
					);
					return toolResult({ reviewing: true });
				} finally {
					if (ownsRuntime(active)) transitioningNames.delete(target.name);
				}
			}
			if (params.action === "interrupt") {
				const target = requireWorker(active.store.state, requiredString(params.worker, "worker"));
				if (target.status !== "working") throw new Error(`${target.name} 当前是 ${target.status}，不能 interrupt`);
				const session = active.pool.getSession(target.sessionPath);
				if (!session) throw new Error(`${target.name} 的进程内会话已释放，无法 interrupt`);
				const run = activeRuns.get(target.sessionPath);
				if (!run) throw new Error(`${target.name} 当前没有可中断的回合`);
				interruptedRuns.set(target.sessionPath, run);
				try {
					await session.abort();
					requireRuntimeOwner(active);
					return toolResult({ interrupted: true });
				} catch (error) {
					if (ownsRuntime(active) && interruptedRuns.get(target.sessionPath) === run) interruptedRuns.delete(target.sessionPath);
					throw error;
				}
			}
			if (params.action === "send") {
				if (params.review === true && reviewGate) throw new Error(reviewGate);
				const target = requireWorker(active.store.state, requiredString(params.worker, "worker"));
				if (target.status !== "idle" || transitioningNames.has(target.name))
					throw new Error(`${target.name} 正在处理其他动作；急件先 interrupt 再 send`);
				const requestedRole = optionalString(params.role);
				const selection = requestedRole ? resolveRole(roster, requestedRole) : undefined;
				const requestedThinking = optionalString(params.thinking);
				if (requestedThinking && !THINKING_LEVELS.includes(requestedThinking as WorkerRef["thinking"]))
					throw new Error(`thinking 值无效：${requestedThinking}`);
				const prompt = requiredString(params.prompt, "prompt");
				validateDelegationText(prompt);
				transitioningNames.add(target.name);
				try {
					const nextModel = selection
						? await (dependencies.resolveModel ?? resolveConfiguredModel)(selection.model)
						: undefined;
					requireRuntimeOwner(active);
					const session = await openWorkerSession(active, target);
					await session.waitForIdle();
					requireRuntimeOwner(active);
					let role = target.role;
					let model = target.model;
					let thinking = target.thinking;
					if (selection && nextModel) {
						await session.setModel(nextModel);
						requireRuntimeOwner(active);
						role = selection.role;
						model = selection.model;
						thinking = selection.thinking;
					}
					if (selection || requestedThinking) {
						thinking = requestedThinking as WorkerRef["thinking"] | undefined ?? thinking;
						session.setThinkingLevel(thinking);
					}
					const current = currentWorker(active, target);
					const { disposition: _disposition, interruptedAt, ...rest } = current;
					const activeWorker: WorkerRef = {
						...rest,
						role,
						model,
						thinking,
						status: "working",
						...(params.review === true || target.reviewNeeded ? { reviewNeeded: true } : {}),
					};
					clearInterruptTimer(target.name);
					active.idleSince.delete(target.sessionPath);
					active.store.dispatch({ type: "UPSERT_WORKER", worker: activeWorker });
					const text = interruptedAt ? `${resumeCheckPrompt()}\n\n${prompt}` : prompt;
					runWorker(active, activeWorker, session, text);
					return toolResult({ sent: true });
				} finally {
					if (ownsRuntime(active)) transitioningNames.delete(target.name);
				}
			}
			if (params.action !== "start") throw new Error(`未知 subagents action：${String(params.action)}`);
			if (params.review === true && reviewGate) throw new Error(reviewGate);
			if (typeof params.worker !== "string" || !params.worker.trim())
				throw new Error("start 需要 worker：给子代理起个简短任务名（如 fix-auth、repo-scan）");
			const name = params.worker.trim();
			validateWorkerName(name);
			if (active.store.state.workers.some((worker) => worker.name === name) || startingNames.has(name))
				throw new Error(`子代理已存在：${name}`);
			const inFlight = active.store.state.workers.filter((worker) => worker.status === "working" || worker.status === "reviewing");
			if (inFlight.length + startingNames.size >= 15)
				throw new Error(`Worker 并发上限 15，当前在飞：${[...inFlight.map((worker) => worker.name), ...startingNames].join("、")}`);
			const prompt = requiredString(params.prompt, "prompt");
			validateDelegationText(prompt);
			const selectedRole = resolveRole(roster, requiredString(params.role, "start 必须指定 role"));
			const requestedThinking = optionalString(params.thinking);
			if (requestedThinking && !THINKING_LEVELS.includes(requestedThinking as WorkerRef["thinking"]))
				throw new Error(`thinking 值无效：${requestedThinking}`);
			const selection = {
				...selectedRole,
				thinking: requestedThinking as WorkerRef["thinking"] | undefined ?? selectedRole.thinking,
			};
			startingNames.add(name);
			try {
				const cwd = await resolveWorkerCwd(optionalString(params.cwd) ?? ctx.cwd);
				requireRuntimeOwner(active);
				const mainSessionPath = ctx.sessionManager.getSessionFile?.();
				if (!mainSessionPath) throw new Error("主会话尚未落盘，无法创建子代理会话目录");
				const sessionPath = preallocateWorkerSession(mainSessionPath, cwd);
				const worker: WorkerRef = {
					name,
					role: selection.role,
					model: selection.model,
					thinking: selection.thinking,
					status: "working",
					sessionPath,
					cwd,
					...(params.review === true ? { reviewNeeded: true } : {}),
				};
				active.store.dispatch({ type: "UPSERT_WORKER", worker });
				startingNames.delete(name);
				try {
					const model = await (dependencies.resolveModel ?? resolveConfiguredModel)(selection.model);
					requireRuntimeOwner(active);
					const spawned = await active.pool.spawn({
						cwd,
						role: "worker",
						model,
						thinking: selection.thinking,
						tools: WORKER_TOOLS,
						excludeExtensions: exclusions,
						systemPrompt: { mode: "append", text: assembleWorkerPrompt(requirePrompts().worker, name) },
						contextFiles: true,
						persistence: { type: "file", sessionPath },
					});
					if (!ownsRuntime(active)) {
						spawned.dispose();
						requireRuntimeOwner(active);
					}
					runWorker(active, worker, spawned.session, prompt);
					return toolResult({ started: true, worker: compactWorker(worker) });
				} catch (error) {
					if (ownsRuntime(active)) active.store.dispatch({ type: "REMOVE_WORKER", name });
					throw error;
				}
			} finally {
				if (ownsRuntime(active)) startingNames.delete(name);
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		deactivate();
		if (!autoActivate) return;
		try {
			activateSession(ctx);
		} catch (error) {
			ctx.ui.notify(`指挥官模式恢复失败：${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	pi.on("session_shutdown", () => deactivate());
}

function settleWorker(
	active: MasterRuntime,
	identity: WorkerRef,
	terminal: WorkerTerminal | undefined,
	error?: unknown,
): string | undefined {
	const current = active.store.state.workers.find((worker) => worker.name === identity.name);
	if (!current || current.sessionPath !== identity.sessionPath) return undefined;
	active.store.dispatch({ type: "UPSERT_WORKER", worker: { ...current, status: "idle" } });
	active.currentTools.delete(identity.sessionPath);
	active.idleSince.set(identity.sessionPath, Date.now());
	const obligation = current.reviewNeeded ? "\n此票有审查义务，请显式 review。" : "";
	const failure = error instanceof Error ? error.message : error === undefined ? terminalFailure(terminal) : String(error);
	return failure
		? `子代理 ${identity.name} 已停下\n${sectionLine("error")}\n${failure}${obligation}`
		: `子代理 ${identity.name} 已停下\n${sectionLine("reply")}\n${terminal!.text}${obligation}`;
}

function unackedEvents(ctx: ExtensionContext): PendingMasterEvent[] {
	const entries = ctx.sessionManager.getEntries?.() ?? [];
	const pending = new Map<string, PendingMasterEvent>();
	const acked = new Set<string>();
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as { type?: unknown; customType?: unknown; data?: unknown };
		if (record.type !== "custom" || !record.data || typeof record.data !== "object") continue;
		const data = record.data as Record<string, unknown>;
		if (record.customType === PENDING_EVENT_TYPE && typeof data.id === "string" && typeof data.content === "string")
			pending.set(data.id, { id: data.id, content: data.content, ...(typeof data.worker === "string" ? { worker: data.worker } : {}) });
		if (record.customType === EVENT_ACK_TYPE && Array.isArray(data.ids))
			for (const id of data.ids) if (typeof id === "string") acked.add(id);
	}
	return [...pending.values()].filter((event) => !acked.has(event.id));
}

function monitorReview(
	session: { subscribe: (listener: (event: { type: string }) => void) => () => void; prompt: (text: string) => Promise<void> },
	sessionPath: string,
	previousRunId: string | undefined,
): Promise<ReviewOutcome> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let unsubscribe = () => {};
		const fail = (error: unknown) => {
			if (settled) return;
			settled = true;
			unsubscribe();
			reject(error);
		};
		const finish = (outcome: ReviewOutcome) => {
			if (settled) return;
			const runId = reviewRunId(outcome);
			if (outcome.status !== "error"
				&& (!runId || runId === previousRunId || outcome.status === "in_progress" || outcome.status === "none")) return;
			settled = true;
			unsubscribe();
			resolve(outcome);
		};
		unsubscribe = session.subscribe((event) => {
			if (event.type === "entry_appended") finish(readReviewOutcome(sessionPath));
		});
		void session.prompt("/fire-review").then(
			() => {
				const outcome = readReviewOutcome(sessionPath);
				const runId = reviewRunId(outcome);
				if (outcome.status === "error") return finish(outcome);
				if (!runId || runId === previousRunId)
					return fail(new Error("fire-review 审查未启动"));
				finish(outcome);
			},
			fail,
		);
	});
}

function reviewRunId(outcome: ReviewOutcome): string | undefined {
	return "runId" in outcome ? outcome.runId : undefined;
}

function reviewOutcomeText(
	name: string,
	outcome: ReviewOutcome,
	messages: Array<{ role: string; content?: unknown }>,
): string {
	const reply = latestAssistantText(messages) || "（无回复）";
	if (outcome.status === "passed") return `子代理 ${name} 审查通过（${outcome.rounds} 轮）\n${sectionLine("finalReply")}\n${reply}`;
	if (outcome.status === "stopped") return `子代理 ${name} 审查停止（${outcome.rounds} 轮）${outcome.advisorAdvice ? `：${outcome.advisorAdvice}` : ""}\n${sectionLine("finalReply")}\n${reply}`;
	if (outcome.status === "failed") return `子代理 ${name} 审查未完成：${outcome.reason}\n${sectionLine("finalReply")}\n${reply}`;
	if (outcome.status === "error") return `子代理 ${name} 审查读取失败：${outcome.message}`;
	return `子代理 ${name} 审查未完成`;
}

function captureWorkerTerminal(
	messages: Array<{ role: string; content?: unknown; stopReason?: string; errorMessage?: string }>,
): WorkerTerminal | undefined {
	const message = messages.findLast((candidate) => candidate.role === "assistant");
	if (!message) return undefined;
	return {
		text: assistantText(message.content),
		...(message.stopReason ? { stopReason: message.stopReason } : {}),
		...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
	};
}

function terminalFailure(terminal: WorkerTerminal | undefined): string | undefined {
	if (!terminal) return "回合结束但未产生 assistant 终态";
	if (terminal.stopReason === "error") return terminal.errorMessage || "供应商返回未知错误";
	if (terminal.stopReason === "aborted") return `回合意外中止：${terminal.errorMessage || "供应商未提供原因"}`;
	if (!terminal.text) return "回合结束但未产生回复";
	return undefined;
}

function providerFaultReason(terminal: WorkerTerminal | undefined): string | undefined {
	if (terminal?.stopReason !== "error" || !terminal.errorMessage) return undefined;
	const message = terminal.errorMessage;
	if (/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota (?:exceeded|exhausted)|billing/iu.test(message))
		return "额度或计费耗尽";
	if (/(?:model|deployment).*(?:not found|does not exist|unavailable|not available|unsupported)|(?:not found|unavailable).*(?:model|deployment)/iu.test(message))
		return "模型不可用或找不到";
	if (/\b(?:500|502|503|504|524)\b|service.?unavailable|internal.?server.?error/iu.test(message))
		return "持续 5xx，宿主重试已用尽";
	return undefined;
}

function latestAssistantText(messages: Array<{ role: string; content?: unknown }>): string {
	const message = messages.findLast((candidate) => candidate.role === "assistant");
	return assistantText(message?.content);
}

function assistantText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			!!part && typeof part === "object" && (part as { type?: unknown }).type === "text"
			&& typeof (part as { text?: unknown }).text === "string")
		.map((part) => part.text)
		.join("\n");
}

async function resolveConfiguredModel(id: string): Promise<Model<any>> {
	const runtime = await ModelRuntime.create({
		authPath: `${getAgentDir()}/auth.json`,
		modelsPath: `${getAgentDir()}/models.json`,
	});
	const slash = id.indexOf("/");
	const model = slash > 0 ? runtime.getModel(id.slice(0, slash), id.slice(slash + 1)) : undefined;
	if (!model) throw new Error(`找不到模型：${id}`);
	return model;
}

function reviewGateError(): string | undefined {
	const loaded = loadConfig();
	if (loaded.config.features.review === false) return "fire-review 已关闭，不能挂审查义务或发起审查";
	const problems = loaded.problems.filter((problem) =>
		problem.startsWith("review") || problem.startsWith("未知字段 review.") || problem.startsWith("config.jsonc"));
	return problems.length ? `fire-review 配置有问题，已停止：${problems.join("；")}` : undefined;
}

function loadMasterPrompts() {
	try {
		return {
			master: readMasterPrompt("master"),
			worker: readMasterPrompt("worker"),
		};
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function loadMasterConfiguration() {
	let loaded: ReturnType<typeof loadConfig>;
	try {
		loaded = loadConfig();
	} catch (error) {
		return { error: `Master 配置读取失败：${error instanceof Error ? error.message : String(error)}` };
	}
	const problems = loaded.problems.filter((problem) => problem.startsWith("master") || problem.startsWith("未知字段 master.") || problem.startsWith("未知角色 master.") || problem.startsWith("config.jsonc") || problem.startsWith("features"));
	if (problems.length) return { error: `Master 配置有问题，已停止：${problems.join("；")}` };
	if (!loaded.config.master.roles.length) return { error: "Master 配置有问题，已停止：请在 master.roles 至少配置一个角色" };
	return loaded.config.master;
}

function resolveRole(roles: MasterRole[], role: string): MasterRole {
	const entry = roles.find((candidate) => candidate.role === role);
	if (!entry) throw new Error(`角色未配置：${role}。已配置角色：${roles.map((candidate) => candidate.role).join("、")}`);
	return entry;
}

function nextFallback(role: MasterRole, worker: WorkerRef): MasterModelAtom | undefined {
	const chain: MasterModelAtom[] = [role, ...role.fallback];
	let index = chain.findIndex((atom) => atom.model === worker.model && atom.thinking === worker.thinking);
	if (index < 0) index = chain.findIndex((atom) => atom.model === worker.model);
	return chain[index + 1];
}

function rosterText(models: MasterRole[]): string {
	return models.map((entry) => {
		const fallback = entry.fallback.length
			? `，fallback ${entry.fallback.map(modelAtomText).join(" → ")}`
			: "";
		return `${entry.role}：${modelAtomText(entry)}（${entry.use}${fallback}）`;
	}).join("；");
}

function modelAtomText(atom: Pick<MasterModelAtom, "model" | "thinking">): string {
	return `${atom.model}/${atom.thinking}`;
}

function masterEventEnvelope(content: string): string {
	return `<firecode_master_event>\n${content}\n</firecode_master_event>`;
}

function resumeCheckPrompt(): string {
	return masterEventEnvelope("上次被外部中断，先核对 git status 与现场再继续，避免重复执行已经发生的副作用。");
}

function fallbackResumePrompt(from: string, to: string, reason: string): string {
	return masterEventEnvelope(`供应商故障，已切换 ${from}→${to}（${reason}）。沿用当前会话与原工作说明，从中断处继续，不要重复已经完成的副作用。`);
}

const ACTION_VERB: Record<string, string> = { start: "启动", list: "查看", kill: "移除", send: "发送", interrupt: "中断", review: "审查", tail: "近况", ack: "待命" };
function subagentsCallParts(args: Record<string, unknown>): Part[] {
	const action = typeof args.action === "string" ? args.action : "?";
	const parts: Part[] = [{ text: ACTION_VERB[action] ?? action, bold: true }];
	const target = optionalString(args.worker);
	if (target) parts.push({ text: ` ${target}`, color: "accent" });
	const role = optionalString(args.role);
	if ((action === "start" || action === "send") && role) parts.push({ text: ` · ${role}`, color: "muted" });
	const prompt = optionalString(args.prompt)?.split("\n", 1)[0];
	if (prompt && action === "start") parts.push({ text: ` — ${prompt}`, color: "muted" });
	return parts;
}

const renderSubagentsResult = makeResultRenderer(false);
const STATUS_WORD = { working: "工作", idle: "空闲", reviewing: "审查" } satisfies Record<WorkerStatus, string>;
const SPINNER_FRAMES = [..."⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"];
const SPINNER_MS = 120;

function reviewProgressFromEntry(entry: unknown): ReviewProgress | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const record = entry as { type?: unknown; customType?: unknown; data?: unknown };
	if (record.type !== "custom" || record.customType !== "firecode-review-checkpoint") return undefined;
	if (!record.data || typeof record.data !== "object") return undefined;
	const active = (record.data as { active?: unknown }).active;
	if (!active || typeof active !== "object") return undefined;
	const progress = active as { round?: unknown; settledCount?: unknown; reviewers?: unknown };
	if (
		typeof progress.round !== "number"
		|| typeof progress.settledCount !== "number"
		|| !Array.isArray(progress.reviewers)
	) return undefined;
	return {
		kind: "review",
		round: progress.round,
		settled: progress.settledCount,
		total: progress.reviewers.length,
	};
}

function currentWorkerAction(active: MasterRuntime, worker: ReturnType<typeof compactWorker>) {
	if (worker.status === "reviewing") return active.reviewProgress.get(worker.session);
	if (worker.status === "idle") {
		let since = active.idleSince.get(worker.session);
		try {
			since ??= statSync(worker.session).mtimeMs;
		} catch {
			// 缺失档案仍可 list；真正恢复时由 send 明确报错。
		}
		return { kind: "idle" as const, ...(since ? { since } : {}) };
	}
	const current = [...(active.currentTools.get(worker.session)?.values() ?? [])].at(-1);
	return current ? { kind: "tool" as const, ...current } : undefined;
}

function expandedWorkerList(
	workers: unknown[],
	theme: ExtensionContext["ui"]["theme"],
	context: Parameters<typeof renderSubagentsResult>[3],
) {
	return {
		invalidate() {},
		render(width: number): string[] {
			return ["", ...workers.flatMap((value) => {
				const worker = value as Record<string, unknown>;
				const action = worker.currentAction as {
					kind?: string;
					tool?: string;
					startedAt?: number;
					since?: number;
					round?: number;
					settled?: number;
					total?: number;
				} | undefined;
				const actionParts: Part[] = action?.kind === "tool" && action.tool && action.startedAt
					? [{
						text: ` · ${action.tool} · 已 ${formatDuration(Math.max(0, Date.now() - action.startedAt))}`,
						color: "accent",
					}]
					: action?.kind === "idle"
						? [{
							text: action.since ? ` · 落定 ${formatDuration(Date.now() - action.since)}前` : " · 已落定",
							color: "muted",
						}]
						: action?.kind === "review"
							? [{ text: ` · 第 ${action.round} 轮 · 审查者 ${action.settled}/${action.total}`, color: "accent" }]
							: [];
				return new ToolLine({
					label: String(worker.name),
					value: [
						{ text: roleStatusText(worker), color: "accent" },
						...actionParts,
						{ text: ` · ${String(worker.model).split("/").pop()}/${String(worker.thinking)}`, color: "muted" },
					],
					clip: "end",
					theme,
					ctx: { ...context, state: {}, expanded: false },
				}).render(width);
			})];
		},
	};
}
function listMeta(workers: unknown[]): Part[] {
	if (!workers.length) return [{ text: " — 池 0", color: "muted" }];
	return [{ text: ` — 池 ${workers.length}：${workers.map((value) => {
		const worker = value as Record<string, unknown>;
		return `${String(worker.name)} ${roleStatusText(worker)}`;
	}).join(" · ")}`, color: "muted" }];
}
/** 角色为主的状态投影：「工程师·工作」；档案缺角色时退到纯状态词。 */
function roleStatusText(worker: { role?: unknown; status?: unknown }): string {
	const status = STATUS_WORD[worker.status as WorkerStatus] ?? String(worker.status);
	return worker.role ? `${String(worker.role)}·${status}` : status;
}
/** 有子代理在飞（工作或审查）时底栏活动动画运转，也是动画计时器的唯一起停判据。 */
export function masterActive(workers: ReadonlyArray<Pick<WorkerRef, "status">>): boolean {
	return workers.some((worker) => worker.status !== "idle");
}
export function masterStatusLine(
	workers: ReadonlyArray<Pick<WorkerRef, "status" | "role">>,
	theme: Pick<ExtensionContext["ui"]["theme"], "fg">,
	frame = 0,
): string {
	if (!workers.length) return theme.fg("dim", "👑 指挥官");
	const spinner = masterActive(workers) ? `${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ` : "";
	const byRole = new Map<string, number>();
	let idle = 0;
	for (const worker of workers) {
		if (worker.status === "idle") idle += 1;
		else {
			const initial = roleInitial(worker.role);
			byRole.set(initial, (byRole.get(initial) ?? 0) + 1);
		}
	}
	const counts = [...byRole].map(([initial, count]) => `${initial}${count}`);
	if (idle) counts.push(`闲${idle}`);
	return theme.fg("dim", `👑 ${spinner}${counts.join("·")}`);
}
/** 角色首字（按 code point 取，兼容 emoji 角色名）；无角色时以工作态首字兜底。 */
function roleInitial(role: string | undefined): string {
	return [...(role ?? "")][0] ?? STATUS_WORD.working[0]!;
}
export function statusText(workers: WorkerRef[]): string {
	return workers.length
		? workers.map((worker) => `${worker.name} ${roleStatusText(worker)} ${worker.model.split("/").pop()}`).join("\n")
		: "没有子代理";
}
function compactWorker(worker: WorkerRef) {
	return {
		name: worker.name,
		role: worker.role,
		status: worker.status,
		model: worker.model,
		thinking: worker.thinking,
		session: worker.sessionPath,
		...(worker.interruptedAt ? { interruptedAt: worker.interruptedAt } : {}),
		...(worker.reviewNeeded ? { reviewNeeded: true } : {}),
		...(worker.disposition ? { disposition: worker.disposition } : {}),
	};
}

async function readWorkerTrace(worker: WorkerRef): Promise<string> {
	let raw: string;
	try {
		raw = await readFile(worker.sessionPath, "utf8");
	} catch (error) {
		throw new Error(`无法读取子代理 ${worker.name} 会话：${error instanceof Error ? error.message : String(error)}`);
	}
	const lines: string[] = [];
	for (const line of raw.split(/\r?\n/u)) {
		if (!line) continue;
		try {
			const entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
			if (entry.type !== "message" || !entry.message?.role) continue;
			const text = messageText(entry.message.content);
			if (text) lines.push(`${entry.message.role}: ${text}`);
		} catch {
			// 正在追加的尾行可暂时不完整；近况保留此前完整记录。
		}
	}
	return `子代理 ${worker.name} 近况（${worker.status}）\n${lines.join("\n").slice(-4_000)}`;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			!!part && typeof part === "object" && (part as { type?: unknown }).type === "text"
			&& typeof (part as { text?: unknown }).text === "string")
		.map((part) => part.text)
		.join("\n");
}
function toolResult(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
}
function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 不能为空`);
	return value.trim();
}
function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function validateWorkerName(name: string): void {
	if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(name)) throw new Error("Worker name 必须匹配 [a-z][a-z0-9_-]{0,31}");
}
function validateDelegationText(prompt: string): void {
	const text = prompt.trimStart();
	if (/^\/skills?:/u.test(text) && !text.startsWith("/skill:tdd ")) throw new Error("委派文本只允许 /skill:tdd 技能前缀");
}
async function resolveWorkerCwd(path: string): Promise<string> {
	if (!isAbsolute(path)) throw new Error("cwd 必须是已存在的绝对目录");
	try {
		return await realpath(path);
	} catch {
		throw new Error(`cwd 不存在：${path}`);
	}
}
async function outsideCheckoutReason(path: string, cwd: string): Promise<string | undefined> {
	const root = await realpath(cwd);
	const target = await canonicalWritePath(resolve(cwd, path));
	const local = relative(root, target);
	return local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local) ? `子代理只能修改当前 checkout：${path}` : undefined;
}
async function canonicalWritePath(path: string): Promise<string> {
	let ancestor = path;
	const missing: string[] = [];
	while (true) {
		try {
			return resolve(await realpath(ancestor), ...missing.reverse());
		} catch {
			const parent = dirname(ancestor);
			if (parent === ancestor) return path;
			missing.push(basename(ancestor));
			ancestor = parent;
		}
	}
}
