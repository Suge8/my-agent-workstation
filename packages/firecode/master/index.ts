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
import { loadConfig, type MasterModel } from "../config.js";
import { formatDuration } from "../format.js";
import { readReviewOutcome, type ReviewOutcome } from "../review/outcome.js";
import { ToolLine, makeResultRenderer } from "../tools/line.js";
import type { Part } from "../tools/parts.js";
import { registerMasterEventRenderer } from "./event-card.js";
import { MASTER_EVENT_TYPE, masterEventDetails, sectionLine } from "./event-format.js";
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
	turnActive: boolean;
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
	const roster = "error" in loaded ? [] : loaded.models;
	const guidelines = masterGuidelines(roster).join("\n");
	const exclusions = "error" in loaded ? [] : loaded.workerExcludeExtensions;
	const autoActivate = "error" in loaded ? false : loaded.autoActivate;
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
	const renderStatus = () => {
		if (!runtime) return;
		runtime.ctx.ui.setStatus("master", masterStatusLine(runtime.store.state.workers, runtime.ctx.ui.theme));
	};
	const activate = (ctx: ExtensionContext, restored?: MasterState): MasterRuntime => {
		if ("error" in loaded) throw new Error(loaded.error);
		if (runtime) {
			runtime.ctx = ctx;
			return runtime;
		}
		const store = new MasterStore(masterStatePath(ctx.sessionManager.getSessionId()), restored, renderStatus);
		runtime = {
			ctx,
			store,
			pool,
			events: [],
			currentTools: new Map(),
			idleSince: new Map(),
			reviewProgress: new Map(),
			observedSessions: new Map(),
			turnActive: false,
		};
		setTools(true);
		if (store.discardedLegacyVersion !== undefined)
			ctx.ui.notify(`旧版 v${store.discardedLegacyVersion} 子代理池已丢弃并从空池重建；旧运行时进程不会纳入新池，请手动清理`, "warning");
		// store 创建时 runtime 尚未就位，激活完成后只补这一次首绘。
		renderStatus();
		return runtime;
	};
	const deactivate = () => {
		const active = runtime;
		runtime = undefined;
		pool.disposeAll();
		for (const timer of interruptTimers.values()) clearTimeout(timer);
		interruptTimers.clear();
		activeRuns.clear();
		interruptedRuns.clear();
		if (active?.flushTimer) clearTimeout(active.flushTimer);
		for (const observed of active?.observedSessions.values() ?? []) observed.unsubscribe();
		active?.ctx.ui.setStatus("master", undefined);
		setTools(false);
	};
	const flushEvents = (active: MasterRuntime) => {
		active.flushTimer = undefined;
		if (runtime !== active || !active.events.length) return;
		const batch = active.events.splice(0);
		const content = batch.map((event) => event.content).join("\n\n");
		try {
			pi.sendMessage(
				{ customType: MASTER_EVENT_TYPE, content: masterEventEnvelope(content), display: true, details: masterEventDetails(batch.map((event) => event.content)) },
				{ deliverAs: "steer", triggerTurn: !active.turnActive && active.ctx.isIdle?.() === true },
			);
		} catch (error) {
			active.events.unshift(...batch);
			active.ctx.ui.notify(`子代理结果投递失败，将自动重试：${String(error)}`, "warning");
			active.flushTimer = setTimeout(() => flushEvents(active), EVENT_RETRY_MS);
			active.flushTimer.unref?.();
			return;
		}
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
	};
	const enqueueEvent = (
		active: MasterRuntime,
		content: string,
		worker?: string,
		persist = true,
		id = crypto.randomUUID(),
	) => {
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
		clearInterruptTimer(worker.name);
		const duration = dependencies.interruptResumeMs ?? 5 * 60_000;
		const delay = Math.max(0, (worker.interruptedAt ?? Date.now()) + duration - Date.now());
		const timer = setTimeout(() => {
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
		const current = active.store.state.workers.find((worker) => worker.name === identity.name);
		if (current?.sessionPath === identity.sessionPath) return current;
		active.pool.dispose(identity.sessionPath);
		throw new Error(`${identity.name} 已被 kill，取消本次动作`);
	};
	const openWorkerSession = async (worker: WorkerRef) => {
		const hot = pool.getSession(worker.sessionPath);
		if (hot) return hot;
		const model = await (dependencies.resolveModel ?? resolveConfiguredModel)(worker.model);
		const spawned = await pool.spawn({
			cwd: worker.cwd ?? process.cwd(),
			role: "worker",
			model,
			thinking: worker.thinking,
			tools: WORKER_TOOLS,
			excludeExtensions: exclusions,
			systemPrompt: { mode: "append", text: workerInstructions(worker.name) },
			contextFiles: true,
			persistence: { type: "file", sessionPath: worker.sessionPath, resume: true },
		});
		return spawned.session;
	};
	const observeWorker = (active: MasterRuntime, sessionPath: string, session: AgentSession) => {
		const previous = active.observedSessions.get(sessionPath);
		if (previous?.session === session) return;
		previous?.unsubscribe();
		const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
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
		observeWorker(active, worker.sessionPath, session);
		const run = Symbol(worker.name);
		activeRuns.set(worker.sessionPath, run);
		const settled = (error?: unknown) => {
			if (activeRuns.get(worker.sessionPath) !== run) return;
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
			const content = settleWorker(active, worker, session.messages, error);
			if (content) enqueueEvent(active, content, worker.name);
		};
		void session.prompt(prompt).then(() => settled(), settled);
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
		return { systemPrompt: `${event.systemPrompt}\n\n${guidelines}` };
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
		description: "指挥官的七动作子代理接口：start 新建，send 续派或切换模型，interrupt 中断，review 显式审查，tail 读轨迹，ack 确认落定，kill 收口移除；无 sleep/session。",
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
			model: Type.Optional(Type.String({ description: "start 必填：从选型表选 provider/model；send 可传以原地切换，省略则沿用。" })),
			thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: "start 必填；send 可传以原地切换思考档，省略则沿用。" })),
			cwd: Type.Optional(Type.String({ description: "仅 start 可选：Worker 工作目录的绝对路径，默认当前目录。" })),
			review: Type.Optional(Type.Boolean({ description: "start/send 的重要实现票设 true 以记录审查义务；完成后必须显式发起 review。" })),
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
					const session = await openWorkerSession(target);
					await session.waitForIdle();
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
					transitioningNames.delete(target.name);
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
					return toolResult({ interrupted: true });
				} catch (error) {
					if (interruptedRuns.get(target.sessionPath) === run) interruptedRuns.delete(target.sessionPath);
					throw error;
				}
			}
			if (params.action === "send") {
				if (params.review === true && reviewGate) throw new Error(reviewGate);
				const target = requireWorker(active.store.state, requiredString(params.worker, "worker"));
				if (target.status !== "idle" || transitioningNames.has(target.name))
					throw new Error(`${target.name} 正在处理其他动作；急件先 interrupt 再 send`);
				const requestedModel = optionalString(params.model);
				if (requestedModel && !roster.some((entry) => entry.model === requestedModel))
					throw new Error(`model 不在选型表：${requestedModel}。选型表：${rosterText(roster)}`);
				const requestedThinking = optionalString(params.thinking);
				if (requestedThinking && !THINKING_LEVELS.includes(requestedThinking as WorkerRef["thinking"]))
					throw new Error(`thinking 值无效：${requestedThinking}`);
				const prompt = requiredString(params.prompt, "prompt");
				validateDelegationText(prompt);
				transitioningNames.add(target.name);
				try {
					const nextModel = requestedModel
						? await (dependencies.resolveModel ?? resolveConfiguredModel)(requestedModel)
						: undefined;
					const session = await openWorkerSession(target);
					await session.waitForIdle();
					let model = target.model;
					let thinking = target.thinking;
					if (requestedModel && nextModel) {
						await session.setModel(nextModel);
						model = requestedModel;
					}
					if (requestedThinking) {
						session.setThinkingLevel(requestedThinking as WorkerRef["thinking"]);
						thinking = requestedThinking as WorkerRef["thinking"];
					}
					const current = currentWorker(active, target);
					const { disposition: _disposition, interruptedAt, ...rest } = current;
					const activeWorker: WorkerRef = {
						...rest,
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
					transitioningNames.delete(target.name);
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
			const selection = resolveSelection(roster, params);
			startingNames.add(name);
			try {
				const cwd = await resolveWorkerCwd(optionalString(params.cwd) ?? ctx.cwd);
				const mainSessionPath = ctx.sessionManager.getSessionFile?.();
				if (!mainSessionPath) throw new Error("主会话尚未落盘，无法创建子代理会话目录");
				const sessionPath = preallocateWorkerSession(mainSessionPath, cwd);
				const worker: WorkerRef = {
					name,
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
					const spawned = await active.pool.spawn({
						cwd,
						role: "worker",
						model,
						thinking: selection.thinking,
						tools: WORKER_TOOLS,
						excludeExtensions: exclusions,
						systemPrompt: { mode: "append", text: workerInstructions(name) },
						contextFiles: true,
						persistence: { type: "file", sessionPath },
					});
					runWorker(active, worker, spawned.session, prompt);
					return toolResult({ started: true, worker: compactWorker(worker) });
				} catch (error) {
					active.store.dispatch({ type: "REMOVE_WORKER", name });
					throw error;
				}
			} finally {
				startingNames.delete(name);
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		deactivate();
		if (!autoActivate || "error" in loaded) return;
		try {
			activateSession(ctx);
		} catch (error) {
			ctx.ui.notify(`指挥官模式恢复失败：${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	pi.on("agent_start", () => {
		if (runtime) runtime.turnActive = true;
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (!runtime) return;
		runtime.ctx = ctx;
		runtime.turnActive = false;
	});
	pi.on("session_shutdown", () => deactivate());
}

function settleWorker(
	active: MasterRuntime,
	identity: WorkerRef,
	messages: Array<{ role: string; content?: unknown; stopReason?: string; errorMessage?: string }>,
	error?: unknown,
): string | undefined {
	const current = active.store.state.workers.find((worker) => worker.name === identity.name);
	if (!current || current.sessionPath !== identity.sessionPath) return undefined;
	active.store.dispatch({ type: "UPSERT_WORKER", worker: { ...current, status: "idle" } });
	active.currentTools.delete(identity.sessionPath);
	active.idleSince.set(identity.sessionPath, Date.now());
	const obligation = current.reviewNeeded ? "\n此票有审查义务，请显式 review。" : "";
	const failure = error instanceof Error ? error.message : error === undefined ? latestAssistantError(messages) : String(error);
	return failure
		? `子代理 ${identity.name} 已停下\n${sectionLine("error")}\n${failure}${obligation}`
		: `子代理 ${identity.name} 已停下\n${sectionLine("reply")}\n${latestAssistantText(messages) || "（无回复）"}${obligation}`;
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
	previousRunId?: string,
): Promise<ReviewOutcome> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (outcome: ReviewOutcome) => {
			if (settled) return;
			const runId = reviewRunId(outcome);
			if (outcome.status !== "error"
				&& (!runId || runId === previousRunId || outcome.status === "in_progress" || outcome.status === "none")) return;
			settled = true;
			unsubscribe();
			resolve(outcome);
		};
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "entry_appended") finish(readReviewOutcome(sessionPath));
		});
		const fail = (error: unknown) => {
			if (settled) return;
			settled = true;
			unsubscribe();
			reject(error);
		};
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

function latestAssistantError(
	messages: Array<{ role: string; stopReason?: string; errorMessage?: string }>,
): string | undefined {
	const message = messages.findLast((candidate) => candidate.role === "assistant");
	return message?.stopReason === "error" ? message.errorMessage || "未知错误" : undefined;
}

function latestAssistantText(messages: Array<{ role: string; content?: unknown }>): string {
	const message = messages.findLast((candidate) => candidate.role === "assistant");
	if (!message || !Array.isArray(message.content)) return "";
	return message.content
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

function loadMasterConfiguration() {
	let loaded: ReturnType<typeof loadConfig>;
	try {
		loaded = loadConfig();
	} catch (error) {
		return { error: `Master 配置读取失败：${error instanceof Error ? error.message : String(error)}` };
	}
	const problems = loaded.problems.filter((problem) => problem.startsWith("master") || problem.startsWith("未知字段 master.") || problem.startsWith("config.jsonc") || problem.startsWith("features"));
	if (problems.length) return { error: `Master 配置有问题，已停止：${problems.join("；")}` };
	if (!loaded.config.master.models.length) return { error: "Master 配置有问题，已停止：请显式配置 master.models 选型表" };
	return loaded.config.master;
}

function resolveSelection(models: MasterModel[], params: Record<string, unknown>) {
	const model = optionalString(params.model);
	const entry = models.find((candidate) => candidate.model === model);
	if (!entry) {
		const reason = model ? `model 不在选型表：${model}` : "start 必须显式指定 model";
		throw new Error(`${reason}。选型表：${rosterText(models)}`);
	}
	const thinking = optionalString(params.thinking);
	if (!thinking) throw new Error(`start 必须显式指定 thinking：${entry.model} 默认档是 ${entry.thinking}`);
	if (!THINKING_LEVELS.includes(thinking as WorkerRef["thinking"])) throw new Error(`thinking 值无效：${thinking}`);
	return { model: entry.model, thinking: thinking as WorkerRef["thinking"] };
}

function rosterText(models: MasterModel[]): string {
	return models.map((entry) => `${entry.model}（${entry.use}，thinking ${entry.thinking}）`).join("；");
}

function masterGuidelines(models: MasterModel[]): string[] {
	return [
		"subagents 激活时，你是唯一的指挥官（Master），负责委派与最终验收。",
		`选型表：${rosterText(models)}。start 必须显式传 model 与 thinking。`,
		"哨兵纪律：CI watch、部署观察、长测试等会占住回合的等待类任务，派最便宜模型的哨兵票盯守，结果会自动送达。",
		"收割纪律：调查/哨兵票收割要点后立即 kill；实现票保留待收口。",
		"计划维护纪律：计划产物存在时，其维护责任随指挥权归指挥官。",
		"投递纪律：子代理结果、中断与审查终态都会自动送达你的回合，无需也不要用 list/tail 轮询进度；tail 只用于按需读取执行细节。",
		'调用样板：start {"worker":"fix-auth","model":"provider/model","thinking":"medium","prompt":"自包含工作说明"}。',
	];
}

function masterEventEnvelope(content: string): string {
	return `<firecode_master_event>\n${content}\n</firecode_master_event>`;
}

function resumeCheckPrompt(): string {
	return masterEventEnvelope("上次被外部中断，先核对 git status 与现场再继续，避免重复执行已经发生的副作用。");
}

function workerInstructions(name: string): string {
	return `<firecode_worker name="${name}">\n你是指挥官委派的子代理，只完成工作说明。使用现有工具在当前 checkout 内工作，必须自测并报告证据；不得启动子 Agent、git push 或新增依赖。提交只带自己改动的路径。\n</firecode_worker>`;
}

const ACTION_VERB: Record<string, string> = { start: "启动", list: "查看", kill: "移除", send: "发送", interrupt: "中断", review: "审查", tail: "近况", ack: "待命" };
function subagentsCallParts(args: Record<string, unknown>): Part[] {
	const action = typeof args.action === "string" ? args.action : "?";
	const parts: Part[] = [{ text: ACTION_VERB[action] ?? action, bold: true }];
	const target = optionalString(args.worker);
	if (target) parts.push({ text: ` ${target}`, color: "accent" });
	const model = optionalString(args.model);
	if (action === "start" && model) parts.push({ text: ` · ${model.split("/").pop()}`, color: "muted" });
	const prompt = optionalString(args.prompt)?.split("\n", 1)[0];
	if (prompt && action === "start") parts.push({ text: ` — ${prompt}`, color: "muted" });
	return parts;
}

const renderSubagentsResult = makeResultRenderer(false);
const STATUS_WORD = { working: "工作", idle: "空闲", reviewing: "审查" } satisfies Record<WorkerStatus, string>;

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
						{ text: `${String(worker.model).split("/").pop()}/${String(worker.thinking)}`, color: "muted" },
						{ text: ` · ${STATUS_WORD[worker.status as WorkerStatus] ?? String(worker.status)}`, color: "accent" },
						...actionParts,
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
		return `${String(worker.name)} ${STATUS_WORD[worker.status as WorkerStatus] ?? String(worker.status)}`;
	}).join(" · ")}`, color: "muted" }];
}
export function masterStatusLine(
	workers: ReadonlyArray<Pick<WorkerRef, "status">>,
	theme: Pick<ExtensionContext["ui"]["theme"], "fg">,
): string {
	const count = (status: WorkerStatus) => workers.filter((worker) => worker.status === status).length;
	return `${theme.fg("dim", "👑 指挥官")}${count("working") ? theme.fg("dim", `/工作${count("working")}`) : ""}${count("reviewing") ? theme.fg("dim", `/审${count("reviewing")}`) : ""}${count("idle") ? theme.fg("dim", `/闲${count("idle")}`) : ""}`;
}
export function statusText(workers: WorkerRef[]): string {
	return workers.length
		? workers.map((worker) => `${worker.name} ${STATUS_WORD[worker.status]} ${worker.model.split("/").pop()}`).join("\n")
		: "没有子代理";
}
function compactWorker(worker: WorkerRef) {
	return {
		name: worker.name,
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
