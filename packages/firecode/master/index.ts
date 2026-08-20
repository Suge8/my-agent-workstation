import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MASTER_MODELS, loadConfig, type MasterModel } from "../config.js";
import { ToolLine, makeResultRenderer } from "../tools/line.js";
import type { Part } from "../tools/parts.js";
import { registerMasterEventRenderer } from "./event-card.js";
import { MASTER_EVENT_TYPE, masterEventDetails } from "./event-format.js";
import { HerdrWorkers } from "./herdr.js";
import {
	MasterStore,
	THINKING_LEVELS,
	loadMasterState,
	masterStatePath,
	requireWorker,
	type MasterState,
	type WorkerRef,
	type WorkerStatus,
} from "./state.js";

const MASTER_TOOL = "subagents";
/** 收件箱持久化：结果先落 Master 会话（pending），投递后写 ack；reload/crash 后未 ack 的重投。 */
const PENDING_EVENT_TYPE = "firecode-master-pending-event";
const EVENT_ACK_TYPE = "firecode-master-event-ack";
/** 投递失败后的自重试间隔（退避语义）：重试不依赖新事件或用户开口。 */
const FLUSH_RETRY_DELAY_MS = 5_000;

interface MasterEvent {
	id: string;
	content: string;
	/** 关联子代理：落定类事件送达后要求指挥官发落（ADR-0006）。 */
	worker?: string;
	/** 发落提醒事件：送达即把发落状态推进到 reminded，不再重复提醒。 */
	remind?: boolean;
}

interface MasterRuntime {
	role: "master";
	ctx: ExtensionContext;
	store: MasterStore;
	herdr: HerdrWorkers;
	events: MasterEvent[];
	/** 显式回合状态位：宿主在 emit agent_settled 前就置 idle，不能拿 isIdle 当回合边界。 */
	turnActive: boolean;
	flushTimer?: NodeJS.Timeout;
	/** 连续投递失败次数：只在首次失败时通知，避免持续故障下每 5s 刷一条警告。 */
	flushFailures: number;
}

interface WorkerRuntime {
	role: "worker";
	ctx: ExtensionContext;
	name: string;
}

type Runtime = MasterRuntime | WorkerRuntime;

export function registerMaster(pi: ExtensionAPI): void {
	let runtime: Runtime | undefined;
	const masterModels = loadMasterModels();
	const roster = "error" in masterModels ? DEFAULT_MASTER_MODELS : masterModels.models;
	const reviewGate = reviewGateError();
	// 渲染器无条件注册（与 review 结果卡同策略）：live 与 reload 同一外观。
	registerMasterEventRenderer(pi);

	const setTools = (role?: Runtime["role"]) => {
		const without = pi.getActiveTools().filter((name) => name !== MASTER_TOOL);
		// Worker 就是普通 pi（默认四工具含 bash），只保证拿不到 Master 工具；ADR-0004。
		if (role === "master") pi.setActiveTools([...without, MASTER_TOOL]);
		else pi.setActiveTools(without);
	};

	// 状态栏由状态变更驱动（store onChange）：任何 dispatch 落盘即重绘，调用点不需要记得刷。
	// 读全局 runtime 而非闭包状态：旧 store 的迟到通知要么早退、要么画出当前事实，天然无害。
	const renderStatus = () => {
		if (runtime?.role !== "master") return;
		const { ui } = runtime.ctx;
		ui.setStatus("master", masterStatusLine(runtime.store.state.workers, ui.theme));
	};

	const flushMasterEvents = (active: MasterRuntime) => {
		active.flushTimer = undefined;
		if (runtime !== active || active.events.length === 0) return;
		// 宿主 followUpMode 默认 one-at-a-time：回合中投递多条会被拆成多个回合。
		// 门槛是显式回合位而非 isIdle：宿主在 emit agent_settled 前就置 idle，
		// 那个窗口里 flush 会把同一批结果拆投。agent_settled 才是回合边界。
		if (active.turnActive) return;
		const batch = active.events.splice(0);
		const content = batch.map((event) => event.content).join("\n\n");
		try {
			// content 给模型（完整事实），details 给紧凑卡（每事件一行）；展开态回到 content。
			pi.sendMessage(
				{ customType: MASTER_EVENT_TYPE, content, display: true, details: masterEventDetails(batch.map((event) => event.content)) },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch (error) {
			// 投递失败不丢结果：回队列并定时重排，重试不依赖新事件；pending 未 ack，reload 也能续投。
			active.events.unshift(...batch);
			if (active.flushFailures === 0)
				active.ctx.ui.notify(`子代理结果投递失败，将自动重试：${String(error)}`, "warning");
			active.flushFailures += 1;
			active.flushTimer = setTimeout(() => flushMasterEvents(active), FLUSH_RETRY_DELAY_MS);
			active.flushTimer.unref?.();
			return;
		}
		active.flushFailures = 0;
		// ack 失败只影响去重（reload 后可能重复投递一次），不影响本次已成功的投递。
		try {
			pi.appendEntry(EVENT_ACK_TYPE, { ids: batch.map((event) => event.id) });
		} catch {
			// 重复投递无害，静默即可；下一条 ack 会一并覆盖。
		}
		// 送达即标记发落要求：落定类事件置 pending，提醒事件置 reminded（ADR-0006）。
		// 只标 idle：投递窗口内被用户接手（working）或已休眠的不再背发落要求，避免残留脏标记。
		for (const event of batch) {
			if (!event.worker) continue;
			const target = active.store.state.workers.find((candidate) => candidate.name === event.worker);
			if (!target || target.status !== "idle") continue;
			active.store.dispatch({
				type: "UPSERT_WORKER",
				worker: { ...target, disposition: event.remind ? "reminded" : "pending" },
			});
		}
	};

	/** 回合结束时的发落检查：未发落先提醒一次，提醒后仍不发落升级为用户通知，到此为止。 */
	const sweepDispositions = (active: MasterRuntime) => {
		for (const target of active.store.state.workers) {
			if (target.status !== "idle" || !target.disposition) continue;
			if (target.disposition === "pending") {
				if (active.events.some((event) => event.remind && event.worker === target.name)) continue;
				enqueueMasterEvent(active, {
					id: crypto.randomUUID(),
					content: dispositionReminderText(target.name),
					worker: target.name,
					remind: true,
				}, false);
				continue;
			}
			const { disposition: _cleared, ...rest } = target;
			active.store.dispatch({ type: "UPSERT_WORKER", worker: rest });
			active.ctx.ui.notify(`子代理 ${target.name} 的结果经提醒仍未发落，请人工跟进`, "warning");
		}
	};

	const enqueueMasterEvent = (active: MasterRuntime, event: MasterEvent, persist: boolean) => {
		if (persist) {
			try {
				pi.appendEntry(PENDING_EVENT_TYPE, event);
			} catch (error) {
				// 持久化失败不阻断投递，只失去 crash 恢复保障；如实告知。
				active.ctx.ui.notify(`子代理结果持久化失败（crash 时可能丢失这条）：${String(error)}`, "warning");
			}
		}
		active.events.push(event);
		if (active.flushTimer) return;
		active.flushTimer = setTimeout(() => flushMasterEvents(active), 100);
		active.flushTimer.unref?.();
	};

	const notifyMaster = (content: string, worker?: string) => {
		if (runtime?.role !== "master") return;
		enqueueMasterEvent(runtime, { id: crypto.randomUUID(), content, ...(worker ? { worker } : {}) }, true);
	};

	const activateMaster = async (ctx: ExtensionContext, restored?: MasterState): Promise<MasterRuntime> => {
		if ("error" in masterModels) throw new Error(masterModels.error);
		if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_WORKSPACE_ID)
			throw new Error("/fire-master 必须运行在 Herdr 管理的 Pi pane 中");
		if (runtime?.role === "master") {
			runtime.ctx = ctx;
			return runtime;
		}
		if (runtime?.role === "worker") throw new Error("子代理不能提升为指挥官");
		const path = masterStatePath(ctx.sessionManager.getSessionId());
		const store = new MasterStore(path, restored, renderStatus);
		const activationEvents: Array<{ content: string; worker?: string }> = [];
		let deliverMasterEvent = (content: string, worker?: string): void => {
			activationEvents.push({ content, ...(worker ? { worker } : {}) });
		};
		const herdr = new HerdrWorkers({
			pi,
			store,
			workspaceId: process.env.HERDR_WORKSPACE_ID,
			notifyMaster: (content, worker) => deliverMasterEvent(content, worker),
		});
		try {
			await herdr.resume();
		} catch (error) {
			await herdr.shutdown();
			throw error;
		}
		const candidate: MasterRuntime = { role: "master", ctx, store, herdr, events: [], turnActive: false, flushFailures: 0 };
		runtime = candidate;
		deliverMasterEvent = notifyMaster;
		setTools("master");
		for (const event of activationEvents) notifyMaster(event.content, event.worker);
		// 首绘：resume() 期间 runtime 尚未就位，onChange 早退，激活完成后补一次对齐。
		renderStatus();
		return candidate;
	};

	const deactivate = async (cleanup: boolean): Promise<string[]> => {
		const active = runtime;
		runtime = undefined;
		if (!active) return [];
		try {
			if (active.role !== "master") return [];
			if (active.flushTimer) clearTimeout(active.flushTimer);
			// 等旧实例的在飞启动退出：reload 时新运行时才不会和它交错写同一状态文件。
			await active.herdr.shutdown();
			if (!cleanup) return [];
			const failures = await active.herdr.cleanup();
			if (failures.length === 0) active.store.dispatch({ type: "CLEAR" });
			return failures;
		} finally {
			active.ctx.ui.setStatus("master", undefined);
			setTools();
		}
	};

	pi.registerCommand("fire-master", {
		description: "启动指挥官模式（子代理池）：/fire-master [status|off]",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (input === "status") {
				if (runtime?.role !== "master") {
					ctx.ui.notify("指挥官模式未启动", "info");
					return;
				}
				ctx.ui.notify(statusText(runtime.store.state.workers), "info");
				return;
			}
			if (input === "off") {
				const failures = await deactivate(true);
				ctx.ui.notify(
					failures.length ? `指挥官模式已关闭，但子代理清理失败：${failures.join("；")}` : "指挥官模式已关闭，子代理已清理",
					failures.length ? "warning" : "info",
				);
				return;
			}
			if (input) {
				ctx.ui.notify("/fire-master 只接受 status 或 off；启用后直接描述需求", "error");
				return;
			}
			try {
				await activateMaster(ctx);
				ctx.ui.notify("指挥官模式已启动", "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerTool({
		name: MASTER_TOOL,
		// 渲染字段长在自己的工具定义上，不改注册/激活语义（与"包装原生工具即强制激活"无关）。
		label: "子代理",
		description: "指挥官的并行子代理接口：start 启动或唤醒、send 发消息、interrupt 打断当前回合（会话保留）、review 审查、tail 读近况轨迹、ack 将落定消息标为已处理、list 查看、sleep 休眠（可唤醒）、kill 移除（不可回）。结果异步回传。",
		renderShell: "self",
		renderCall: (args, theme, ctx) =>
			new ToolLine({ label: "子代理", value: subagentsCallParts(args as Record<string, unknown>), clip: "end", theme, ctx }),
		renderResult: (result, options, theme, context) => {
			// 查看的结果回写行内后缀（与 edit ±diff 同一通道）：空池显“空”，否则列出各子代理名与状态。
			const details = result.details as { workers?: unknown } | undefined;
			context.state.meta = !context.isError && Array.isArray(details?.workers) ? listMeta(details.workers) : undefined;
			return renderSubagentsResult(result, options, theme, context);
		},
		promptGuidelines: masterGuidelines(roster),
		parameters: Type.Object({
			action: StringEnum(["list", "start", "send", "review", "tail", "interrupt", "ack", "sleep", "kill"] as const),
			worker: Type.Optional(Type.String({ description: "start 必填简短任务词（如 fix-outcome）；其余 action 指定目标子代理" })),
			prompt: Type.Optional(Type.String()),
			model: Type.Optional(Type.String({ description: "start 新建子代理必填：从选型表挑一个 provider/model（唤醒休眠子代理时省略，沿用其档案）" })),
			thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: "start 新建子代理必填：以选型表默认档为基准按任务深浅确认（唤醒休眠子代理时省略）" })),
			session: Type.Optional(Type.String({ description: "可选：休眠子代理名或 Pi session path" })),
			cwd: Type.Optional(Type.String({ description: "start 可选：子代理工作目录（绝对路径，必须已存在）；默认当前目录" })),
			review: Type.Optional(Type.Boolean({ description: "start/send 可选：委派或追加新实现任务的重要票设 true——完成后自动发起对抗审查并回传终态；唤醒待命、纯追问不设" })),
		}),
		async execute(_id, params: Record<string, unknown>, _signal, _update, ctx) {
			const active = runtime;
			if (active?.role !== "master") throw new Error("subagents 只在 Master 中可用");
			if (params.action === "list") return toolResult({ workers: active.store.state.workers.map(compactWorker) });
			if (params.action === "start") {
				// 审查票在派发时即验可用性：review 不可用就拒绝，不让意图落地后才发现审不了。
				if (params.review === true && reviewGate) throw new Error(reviewGate);
				const selection = resolveSelection(roster, active.store.state, params);
				const worker = await active.herdr.start(ctx, {
					prompt: requiredString(params.prompt, "prompt"),
					...(params.review === true ? { review: true } : {}),
					...(optionalString(params.worker) ? { name: optionalString(params.worker) } : {}),
					...selection,
					...(optionalString(params.session) ? { session: optionalString(params.session) } : {}),
					...(optionalString(params.cwd) ? { cwd: optionalString(params.cwd) } : {}),
				});
				return toolResult({ started: true, worker: compactWorker(worker) });
			}
			if (params.action === "send") {
				// 审查票在派发时即验可用性：与 start 同一道门。
				if (params.review === true && reviewGate) throw new Error(reviewGate);
				await active.herdr.send(requiredString(params.worker, "worker"), requiredString(params.prompt, "prompt"), params.review === true);
				return toolResult({ sent: true });
			}
			if (params.action === "interrupt") {
				// 就绪信号不在此同步等待：中断结算经现有中断事件异步回传，与其它结果同一条通道。
				await active.herdr.interrupt(requiredString(params.worker, "worker"));
				return toolResult({ interrupted: true, note: "中断已投递，就绪信号经中断事件回传，到达后再 send" });
			}
			if (params.action === "ack") {
				// 待命（Ack）：只消发落标记，子代理保持原状；不动中断计时（自动续跑不受 ack 影响）。
				const name = requiredString(params.worker, "worker");
				const target = requireWorker(active.store.state, name);
				// 护栏：对没有待发落标记的非 idle 子代理 ack，唯一合理解释是把它误当暂停——
				// 返回假成功会让指挥官以为子代理已停（真实事故，见 ADR-0007）。报错出路按状态给：
				// 指错动作会让模型多烧一个回合，和护栏要防的是同一类问题。
				if (!target.disposition && target.status !== "idle" && target.status !== "dormant") {
					const guidance = target.status === "blocked"
						? "它在等回答，用 send 回答后继续"
						: target.status === "reviewing"
							? "它正在对抗审查，等审查终态回传"
							: "要打断用 interrupt（保会话），要收起用 sleep（休眠可唤醒）";
					throw new Error(`ack 只把消息标为已处理，${name} 正在 ${target.status}，不会因此停下。${guidance}`);
				}
				if (target.disposition) {
					const { disposition: _acked, ...rest } = target;
					active.store.dispatch({ type: "UPSERT_WORKER", worker: rest });
				}
				return toolResult({ acked: true, worker: name });
			}
			if (params.action === "tail") {
				// 只读快照：不动状态机、不消发落标记（看一眼就算处置是 ADR-0007 那类假成功）。
				// 轨迹是多行文本，直接交原文；JSON 包一层只会把换行转义成噪声。
				const trace = await active.herdr.tail(requiredString(params.worker, "worker"));
				return { content: [{ type: "text" as const, text: trace }] };
			}
			if (params.action === "review") {
				// 门禁：review 关闭时 Worker 会话没有 /fire-review 命令，投递会退化成普通模型输入；
				// 配置有错时命令存在但拒绝启动，只会延迟报“审查未启动”。两种都在投递前拦住。
				if (reviewGate) throw new Error(reviewGate);
				await active.herdr.review(requiredString(params.worker, "worker"));
				return toolResult({ reviewing: true });
			}
			if (params.action === "sleep" || params.action === "kill") {
				// 两者共享同一条中止+关 pane 路径，只差结局：sleep 留休眠引用可唤醒，kill 除名不可回。
				await active.herdr.stop(requiredString(params.worker, "worker"), params.action === "kill");
				return toolResult(params.action === "kill" ? { killed: true } : { sleeping: true });
			}
			throw new Error(`未知 subagents action：${String(params.action)}`);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await deactivate(false);
		const workerName = process.env.FIRECODE_MASTER_WORKER;
		if (workerName) {
			runtime = { role: "worker", ctx, name: workerName };
			setTools("worker");
			// Worker 行是会话级常量，写一次即可，不走状态驱动。
			ctx.ui.setStatus("master", ctx.ui.theme.fg("dim", `↳ ${workerName}`));
			return;
		}
		try {
			const restored = loadMasterState(masterStatePath(ctx.sessionManager.getSessionId()));
			if (restored?.workers.length) {
				const active = await activateMaster(ctx, restored);
				// crash/reload 窗口内未投递的结果凭 pending−ack 差集重投；已在队列的不重复入队。
				const queued = new Set(active.events.map((event) => event.id));
				for (const event of unackedEvents(ctx))
					if (!queued.has(event.id)) enqueueMasterEvent(active, event, false);
				// 持久化的发落状态跨 reload 续期：没有在途事件兑底时补一次提醒（ADR-0006）。
				for (const target of active.store.state.workers) {
					if (target.status !== "idle" || !target.disposition) continue;
					if (active.events.some((event) => event.worker === target.name)) continue;
					enqueueMasterEvent(active, {
						id: crypto.randomUUID(),
						content: dispositionReminderText(target.name),
						worker: target.name,
						remind: true,
					}, false);
				}
			} else setTools();
		} catch (error) {
			setTools();
			ctx.ui.notify(`指挥官模式恢复失败：${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	pi.on("agent_start", () => {
		if (runtime?.role === "master") runtime.turnActive = true;
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (runtime?.role !== "master") return;
		runtime.ctx = ctx;
		runtime.turnActive = false;
		sweepDispositions(runtime);
		if (runtime.events.length === 0 || runtime.flushTimer) return;
		const active = runtime;
		active.flushTimer = setTimeout(() => flushMasterEvents(active), 100);
		active.flushTimer.unref?.();
	});

	pi.on("before_agent_start", (event) => {
		if (runtime?.role === "worker")
			return { systemPrompt: `${event.systemPrompt}\n\n${workerInstructions(runtime.name)}` };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (runtime?.role !== "worker") return;
		if (!isToolCallEventType("edit", event) && !isToolCallEventType("write", event)) return;
		const reason = await outsideCheckoutReason(event.input.path, ctx.cwd);
		if (reason) return { block: true, reason };
	});

	pi.on("session_shutdown", async (event) => {
		await deactivate(event.reason !== "reload");
	});
}

/** 配置门禁与 review 同理：花名册错误会拿错模型真实发起 Worker，静默回退不可接受。 */
function loadMasterModels(): { models: MasterModel[] } | { error: string } {
	let loaded: ReturnType<typeof loadConfig>;
	try {
		loaded = loadConfig();
	} catch (error) {
		return { error: `Master 配置读取失败：${error instanceof Error ? error.message : String(error)}` };
	}
	const problems = loaded.problems.filter(
		(problem) =>
			problem.startsWith("master") ||
			problem.startsWith("未知字段 master.") ||
			problem.startsWith("config.jsonc") ||
			problem.startsWith("features"),
	);
	if (problems.length > 0) return { error: `Master 配置有问题，已停止：${problems.join("；")}` };
	return { models: loaded.config.master.models };
}

/** review action 前置门禁：与 review 模块同源同规则，但在投递前判定，避免把命令发进注定不会开审的会话。 */
function reviewGateError(): string | undefined {
	let loaded: ReturnType<typeof loadConfig>;
	try {
		loaded = loadConfig();
	} catch (error) {
		return `Master 配置读取失败：${error instanceof Error ? error.message : String(error)}`;
	}
	if (loaded.config.features.review === false)
		return "fire-review 已关闭（features.review=false），不能发起子代理审查";
	const problems = loaded.problems.filter(
		(problem) =>
			problem.startsWith("review") ||
			problem.startsWith("未知字段 review.") ||
			problem.startsWith("config.jsonc") ||
			problem.startsWith("features"),
	);
	if (problems.length > 0) return `fire-review 配置有问题，不能发起子代理审查：${problems.join("；")}`;
	return undefined;
}

/**
 * 新建子代理的选型门禁：省略 model 曾静默继承指挥官的模型（常是最贵的一档），
 * 提示词层的“显式传”打不过参数层的“可省略”，因此在代码里堵死这条路。
 * thinking 同理必填：档位直接决定花销，继承指挥官的思考等级同样是静默花钱。
 * 唤醒池内休眠子代理不受约束——身份跟档案走；收编外部 session 没有档案，仍需显式选型。
 */
function resolveSelection(
	models: MasterModel[],
	state: MasterState,
	params: Record<string, unknown>,
): { model?: string; thinking?: string } {
	const model = optionalString(params.model);
	const thinking = optionalString(params.thinking);
	const target = optionalString(params.worker);
	const session = optionalString(params.session);
	const dormant = state.workers.some(
		(worker) => worker.status === "dormant"
			&& (worker.name === target || worker.name === session || worker.sessionPath === session),
	);
	if (dormant) return { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
	const entry = models.find((candidate) => candidate.model === model);
	if (!entry)
		throw new Error(
			`${model ? `model 不在选型表：${model}` : "start 必须显式指定 model"}。按任务从选型表挑一个：${rosterText(models)}。表外模型需用户先改 firecode/config.jsonc 的 master.models。`,
		);
	if (!thinking)
		throw new Error(`start 必须显式指定 thinking：${entry.model} 在选型表的默认档是 ${entry.thinking}，按任务深浅确认后再传。`);
	return { model: entry.model, thinking };
}

function rosterText(models: MasterModel[]): string {
	return models.map((entry) => `${entry.model}（${entry.use}，thinking ${entry.thinking}）`).join("；");
}

function masterGuidelines(models: MasterModel[]): string[] {
	const roster = rosterText(models);
	return [
	"subagents 激活时，你是唯一的指挥官（Master），负责是否委派、如何分派和最终验收；普通问题直接回答，不必开子代理。",
	`指挥官拥有的子代理（Worker）的全部生命周期只经 subagents 工具控制。选型表：${roster}。新建子代理必须按任务性质从表中挑 model、以表内默认档为基准定 thinking，两个参数都显式传给 start（工具会拒绝省略与表外模型，不存在继承当前会话这一路）；用户显式指定则优先。`,
	"硬约束：禁止用 bash 调 herdr CLI 起子代理、给子代理发消息或管子代理生命周期——CLI 起的子代理是脱管子代理，收不到任何完成/阻塞回传、不会自动审查，你会对它们全盲。需要让子代理在其它已存在目录工作时，用 start 的 cwd 参数指定绝对路径（目录本身可先用 bash 准备）。委派文本以 /skill: 或 /skills: 开头时只放行 /skill:tdd，其余会被工具直接拒绝（implement 内含自审、与自动对抗审查冲突；调查/文档/收口票用普通文本）。用户技能文本里的『后台代理』在你的语境即经 subagents 工具管理的子代理，不得用 bash/CLI 另起任何代理进程。start 失败会自动重试；仍失败就把错误报告给用户等待决策，不自行绕道。",
	"发现脱管子代理（在 herdr 里跑但不在 subagents list 中）时收编：等它空闲后让其 pi 退出（会话文件保留），再用 start 传 session 路径拉回池内，上下文无损、回传恢复。",
	"start 的 worker 名用简短任务词（如 fix-outcome、scan-dups）；pane/tab/Pi 会话显示名会自动附加模型名，不要把模型写进 worker 名。",
	"从 Tracker 首次派发前，把完整分波计划连同每张 Ticket 的模型/thinking（建议值取选型表）一次性列给用户确认；确认后各波自动执行不再重复询问，计划变更（如模型无额度）才重新征询。",
	"复杂工作先用当前已加载的 planning skill 拆分；subagents 不依赖任何具体 skill。start 的 prompt 必须自包含：任务、交付物、限制、验证要求（子代理必须自跑受影响测试并附证据），以及最终回复必须包含的结论、证据和未决风险。",
	"仅当项目已有本次流程的 Tracker（本地 .scratch/ 或远端 issue tracker，约定见项目 docs/agents/issue-tracker.md）时才有票务纪律：按 Ticket 阻塞边分波、首批调查票全并行、一波集成验证后解锁下一波；阻塞边除显式依赖外还包括触及路径重叠——共享 checkout 上同文件并行编辑会在提交前就互毁，重叠的 Ticket 必须串行不同波或合并为一票（无 Tracker 的日常并行委派同理）；派发三连：start 成功 → 立即认领（远端 Tracker 一条命令加 assignee、摘待领标签、挂进行中标签，标签名以项目约定为准；本地 .scratch/ 在票内标注子代理名）→ 才向用户汇报，依赖边变更时同步修正受影响票的状态；新立 Ticket 必须声明归属与触发来源——标题带线号或类别词（线号必须出自 spec），票内首行写「来源：哪张票/哪次事件 · 属哪条线 · 阻塞关系」，具体格式以项目 Tracker 约定为准；集成收口摘认领并删票/关票。没有 Tracker 就没有这些票务动作。",
	"轻重之分靠 review 参数，跟着任务走不跟渠道走（start 委派与 send 追加同用）：重要实现工作设 review:true，完成后机器自动发起对抗审查并回传终态（含轮数与顾问裁决），无需你记得或手动触发；轻量票、纯追问不设。凡有可测行为变更的实现票，委派文本默认以 `/skill:tdd ` 开头，并把 spec/Ticket 已定的接缝与验收写进委派文本（接缝在计划层已确认，子代理不再回头询问）；调查、文档、收口、纯重构票用普通自包含说明。`/skill:implement` 是用户 solo 技能（内含自审），Master 委派禁用。斜杠技能只在文本开头且后跟空格才展开，写错静默失效。",
	"审查自动修复循环内不调用 start/send，等待 review 终态；整体收口交给专门的收口子代理，指挥官只派活、分析和决策，不直接改代码。",
	"审查提示词具备并行改动与测试干扰的归因纪律，发起审查无需等其它子代理停笔；subagents 的 review action 可对任意 idle 子代理手动补审（如轻量票事后需要把关）。",
	"tail 读子代理最近一次输入之后的执行轨迹（工具调用、结果、文本与异常停止原因，按预算截断），用来弄清它到底干了什么、卡在哪里；启动中以外的子代理都能读，含休眠。它是只读快照：不得拿它轮询进度或等子代理完工（等待靠结果事件），也不算发落——读完落定消息仍需 send/review/sleep/kill/ack。",
	"子代理结果会以 custom follow-up message 回来。收到落定消息（结果/中断/审查终态/自动续跑提醒）必须当回合发落：send 继续、review 补审、sleep 休眠（关 pane 保上下文，start 传名字可唤醒）、kill 移除（不可再按名字唤醒）、ack 待命（只标记已处理，子代理保持原状；等用户决策也用 ack 并向用户说明）。子代理被中断时按事件指引发落，不要立即重发任务。",
	"中途改方向：interrupt 打断 working 子代理的当前回合（发 esc，会话与 pane 保留，进行中的输出作废），中断事件回来后再 send 新指令。",
	"生命周期：一波集成过审后就 sleep 该波子代理（休眠保上下文，不占屏）；走 CI/合并的项目 push 后保持休眠，红了唤醒对应子代理修，绿了再 kill；全流程结束用 /fire-master off 清场（退出会话也会自动清）。",
	"用户要求 hold/待命：idle 本身就是待命态，ack 发落即可、不要 sleep；已休眠的用 start 唤醒（唤醒待命不设 review，委派文本说明待命勿动），等真正派活时再在 send 上声明审查票。",
	"子代理共享 checkout 且可能并行写入；需要额外限制（如禁改依赖）必须写进工作说明（Delegation）。子代理在发起自审前用带路径提交固定只包含自己的改动（`git commit -m <msg> -- <自己的路径>`，带路径提交走临时索引，天然不携带他人已暂存内容；遇 index.lock 冲突稍候重试；禁止 push），修复回合同样收尾即提交；指挥官在集成点检查新增 commits、运行集成层验证后统一 push，再向用户报告完成。",
	];
}

function workerInstructions(name: string): string {
	return `<firecode_worker name="${name}">
你是指挥官（Master）委派的子代理（Worker），不是指挥官，只完成收到的工作说明。
义务：改完必须自己跑受影响的测试/检查，最终回复交付结论、已运行的验证命令与结果证据、未决风险。
禁令（除非工作说明明确授权）：不碰 herdr 命令、不启动子 Agent、不 git push、不新增或升级依赖（跑现有依赖的测试不受限）、不写 checkout 之外的路径。
提交必须带路径：先 git add <你的路径>，再 git commit -m <msg> -- <你的路径>；带路径提交走临时索引，不会带上他人已暂存的内容；遇 index.lock 冲突稍候重试。
全部完成停下后，若本票被指定需要审查，指挥官会自动从外部对你的会话发起 /fire-review 对抗审查，审查反馈会自动驱动你修复；你自己无法也无需触发它。
</firecode_worker>`;
}

/** 扫描 Master 会话：pending 减 ack 的差集 = 尚未成功投递给模型的结果。 */
function unackedEvents(ctx: ExtensionContext): MasterEvent[] {
	const manager = ctx.sessionManager as { getEntries?: () => unknown[] } | undefined;
	const entries = manager?.getEntries?.() ?? [];
	const pending = new Map<string, MasterEvent>();
	const acked = new Set<string>();
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as { type?: unknown; customType?: unknown; data?: unknown };
		if (record.type !== "custom" || !record.data || typeof record.data !== "object") continue;
		const data = record.data as Record<string, unknown>;
		if (record.customType === PENDING_EVENT_TYPE) {
			if (typeof data.id === "string" && typeof data.content === "string")
				pending.set(data.id, {
					id: data.id,
					content: data.content,
					...(typeof data.worker === "string" ? { worker: data.worker } : {}),
				});
			continue;
		}
		if (record.customType === EVENT_ACK_TYPE && Array.isArray(data.ids))
			for (const id of data.ids) if (typeof id === "string") acked.add(id);
	}
	return [...pending.values()].filter((event) => !acked.has(event.id));
}

const ACTION_VERB: Record<string, string> = {
	start: "启动",
	send: "发送",
	review: "审查",
	tail: "近况",
	interrupt: "中断",
	ack: "待命",
	list: "查看",
	sleep: "休眠",
	kill: "移除",
	// 已退役动作名：仅供历史会话重新渲染旧工具行（ADR-0007）。
	hold: "待命",
	stop: "休眠",
};

/** 工具行一行制：动词 + 目标子代理 + 关键参数，委派文本取首句由 ToolLine 按宽截断。 */
function subagentsCallParts(args: Record<string, unknown>): Part[] {
	const action = typeof args.action === "string" ? args.action : "?";
	// stop+forget 同属历史渲染兜底：旧会话里的遗忘调用按现行词汇显示。
	const verb = action === "stop" && args.forget === true ? "移除" : ACTION_VERB[action] ?? action;
	const parts: Part[] = [{ text: verb, bold: true }];
	const session = optionalString(args.session);
	// session 恢复只显示文件名：整条绝对路径会把行尾截断吃掉真正的信息。
	const target = optionalString(args.worker) ?? session?.split("/").pop();
	if (target) parts.push({ text: ` ${target}`, color: "accent" });
	if (action === "start") {
		const model = optionalString(args.model);
		if (model) parts.push({ text: ` · ${model.split("/").pop()}`, color: "muted" });
	}
	if (args.review === true && (action === "start" || action === "send"))
		parts.push({ text: " · 审查票", color: "muted" });
	const prompt = optionalString(args.prompt)?.split("\n", 1)[0];
	if (prompt && (action === "start" || action === "send"))
		parts.push({ text: ` — ${prompt}`, color: "muted" });
	return parts;
}

function dispositionReminderText(worker: string): string {
	return [
		`提醒：子代理 ${worker} 已交活，等你发落`,
		"send 继续派活；review 补审；sleep 休眠；kill 移除；ack 待命（子代理保持原状；等用户决策也用 ack 并向用户说明）。此提醒只此一次。",
	].join("\n");
}

const renderSubagentsResult = makeResultRenderer(false);

/** 状态栏指挥官行：池状态的纯投影。等 = blocked，唯一需要指挥官出手的状态，warning 高亮；零计数不显示。 */
function masterStatusLine(workers: WorkerRef[], theme: ExtensionContext["ui"]["theme"]): string {
	const counts = new Map<WorkerStatus, number>();
	for (const worker of workers) counts.set(worker.status, (counts.get(worker.status) ?? 0) + 1);
	const part = (label: string, count: number, color: "dim" | "warning" = "dim") =>
		count ? theme.fg(color, `/${label}${count}`) : "";
	return [
		theme.fg("dim", "👑 指挥官"),
		part("工作", (counts.get("starting") ?? 0) + (counts.get("working") ?? 0)),
		part("等", counts.get("blocked") ?? 0, "warning"),
		part("审", counts.get("reviewing") ?? 0),
		part("闲", counts.get("idle") ?? 0),
		part("眠", counts.get("dormant") ?? 0),
	].join("");
}

// satisfies 绑定：WorkerStatus 增删值不同步这张表会编译失败，不会静默退化成英文原词。
const STATUS_WORD = {
	starting: "启动",
	working: "工作",
	blocked: "提问",
	idle: "空闲",
	reviewing: "审查",
	dormant: "休眠",
} satisfies Record<WorkerStatus, string>;

/** list 结果的行内摘要：查看时刻的池快照随工具行留在会话记录里。 */
function listMeta(workers: unknown[]): Part[] {
	if (workers.length === 0) return [{ text: " — 空", color: "muted" }];
	const text = workers
		.map((entry) => {
			const record = entry as Record<string, unknown>;
			const status = typeof record.status === "string" ? STATUS_WORD[record.status as WorkerStatus] ?? record.status : "?";
			return `${typeof record.name === "string" ? record.name : "?"} ${status}`;
		})
		.join(" · ");
	return [{ text: ` — ${text}`, color: "muted" }];
}

function statusText(workers: WorkerRef[]): string {
	if (!workers.length) return "没有子代理";
	return workers.map((worker) => `${worker.name} ${worker.status} ${worker.model}`).join(" · ");
}

function compactWorker(worker: WorkerRef): Record<string, unknown> {
	return {
		name: worker.name,
		status: worker.status,
		model: worker.model,
		thinking: worker.thinking,
		...(worker.sessionPath ? { session: worker.sessionPath } : {}),
	};
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

async function outsideCheckoutReason(path: string, cwd: string): Promise<string | undefined> {
	const root = await realpath(cwd);
	const target = await canonicalWritePath(resolve(cwd, path));
	const local = relative(root, target);
	return local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)
		? `子代理只能修改当前 checkout：${path}`
		: undefined;
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
