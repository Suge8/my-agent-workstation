import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { REVIEW_OCCUPANCY_LABEL, readReviewOutcome, type ReviewOutcome } from "../review/outcome.js";
import { sectionLine } from "./event-format.js";
import {
	liveWorkers,
	requireWorker,
	THINKING_LEVELS,
	type MasterStore,
	type WorkerRef,
	type WorkerThinking,
} from "./state.js";

const RESULT_CONTEXT_LIMIT = 12_000;
/** 近况总预算：够十几步轨迹回答“最后走到哪一步”，与结果回传的上限不同源——一个装最终回复，一个装轨迹。 */
const TRACE_BUDGET = 4_000;
/** 单条工具调用/结果的硬上限：一条长输出不得吃掉整个预算，预算要买到步数而不是日志。 */
const TRACE_ENTRY_LIMIT = 300;
/** 边界注入只做锚点：知道它在回应什么即可，委派正文不占预算大头。 */
const TRACE_ANCHOR_LIMIT = 250;
const MAX_RETRY_DELAY_MS = 30_000;
/** agent.start 遭遇 agent_pane_busy 的重试窗口：shell 就绪标记已匹配，busy 必为
 * herdr 进程快照在高负载下的瞬态误判（实测：同机两个重载型 Worker 并行时四连败），
 * 退避重试到窗口用尽必然成功或暴露真实故障。 */
const START_BUSY_RETRY_WINDOW_MS = 15_000;
/** 占用信号失效时审查监听的轮询兑底间隔。 */
const REVIEW_POLL_DELAY_MS = 2_000;
/** 中断后无人接手的自动续跑等待：定时即业务语义（把流程交还指挥官），非轮询。 */
const INTERRUPT_RESUME_DELAY_MS = 300_000;
const MAX_WORKERS_PER_TAB = 4;

interface HerdrAgent {
	pane_id: string;
	tab_id: string;
	name?: string | null;
	agent_status?: "idle" | "blocked" | "done";
	state_labels?: Record<string, string>;
	agent_session?: { kind?: string; value?: string } | null;
}

interface LatestAssistant {
	text: string;
	stopReason?: string;
	errorMessage?: string;
}

interface StartWorkerOptions {
	prompt: string;
	name?: string;
	model?: string;
	thinking?: string;
	session?: string;
	/** 子代理工作目录（绝对路径，必须已存在）；缺此能力时模型会绕道 CLI（ADR-0005）。 */
	cwd?: string;
	/** 重要票：完成后由机器自动发起对抗审查。 */
	review?: boolean;
}

/** 分配完成、尚待并行启动的子代理：串行临界区的产出，交给 launchWorker 收尾。 */
interface WorkerLaunch {
	provisional: WorkerRef;
	prompt: string;
	model: string;
	thinking: WorkerThinking;
	sessionPath?: string;
	previous?: WorkerRef;
	shell: WorkerShell;
	shellReady: Awaited<ReturnType<typeof createShellReadyMarker>>;
	controller: AbortController;
	signal: AbortSignal;
}

interface WorkerShell {
	paneId: string;
	tabId: string;
	close: "pane" | "tab";
}

type PositionedWorker = WorkerRef & { paneId: string; tabId: string };

export class HerdrWorkers {
	private readonly pi: ExtensionAPI;
	private readonly store: MasterStore;
	private readonly workspaceId: string;
	private readonly notifyMaster: (content: string, dispositionWorker?: string) => void;
	private readonly runs = new Map<string, AbortController>();
	/**
	 * interrupt 指令在飞标记：只改中断事件文案的归因（指令中断 vs 外部介入），不入档案：
	 * reload 丢标记只退化为外部中断文案，状态机与续监完全一致，不值得为此动 schema。
	 */
	private readonly deliberateInterrupts = new Set<string>();
	/** 池级生命周期：shutdown 后中止一切在飞启动，防止清理完成后孤儿子代理复活。 */
	private readonly lifecycle = new AbortController();
	/** 在飞启动集合：shutdown 要等它们真正退出，reload 后新旧运行时才不会同时写状态文件。 */
	private readonly launches = new Set<Promise<unknown>>();
	private startQueue = Promise.resolve();

	constructor(options: {
		pi: ExtensionAPI;
		store: MasterStore;
		workspaceId: string;
		notifyMaster: (content: string, dispositionWorker?: string) => void;
	}) {
		this.pi = options.pi;
		this.store = options.store;
		this.workspaceId = options.workspaceId;
		this.notifyMaster = options.notifyMaster;
	}

	/**
	 * 入队时能解析出的全部身份：显式命名，加 session/休眠引用反查出的旧名。
	 * 改名恢复期间子代理池展示的仍是旧名，按两个身份 stop 都必须命中同一个取消控制器。
	 */
	private queuedStartNames(options: StartWorkerOptions): string[] {
		const names = new Set<string>();
		const explicit = options.name?.trim();
		if (explicit) names.add(explicit);
		const session = options.session?.trim();
		if (session) {
			const referenced = this.store.state.workers.find(
				(worker) => worker.name === session || worker.sessionPath === session,
			)?.name;
			if (referenced) names.add(referenced);
		}
		return [...names];
	}

	async start(ctx: ExtensionContext, options: StartWorkerOptions): Promise<WorkerRef> {
		validateDelegationText(options.prompt);
		// 入队即在全部身份下登记取消控制器；同名并发启动直接拒绝（排队等死还留取消盲区）。
		const names = this.queuedStartNames(options);
		for (const key of names)
			if (this.runs.has(key))
				throw new Error(`${key} 已有进行中的启动或监听任务，不能重复启动`);
		const pending = names.length > 0 ? new AbortController() : undefined;
		for (const key of names) if (pending) this.runs.set(key, pending);
		// 串行区只包住布局分配（读容量 + 建 shell + 写占位）；shell 握手与 agent 启动并行，
		// 首批工单才能真正并行启动。
		const allocated = this.startQueue.then(() => this.allocateWorker(ctx, options, pending));
		this.startQueue = allocated.then(() => undefined, () => undefined);
		const launched = allocated.then((launch) => this.launchWorker(launch));
		const tracked: Promise<WorkerRef> = launched.finally(() => {
			this.launches.delete(tracked);
			if (!pending) return;
			for (const key of names) if (this.runs.get(key) === pending) this.runs.delete(key);
		});
		this.launches.add(tracked);
		return tracked;
	}

	/**
	 * 串行临界区：名字/模型解析、布局容量计算、shell 创建与占位状态写入。
	 * shell 创建必须留在串行区：后一个子代理的象限切分依赖前一个 pane 的落位，
	 * 并发创建会互相拿错容量、误切同一 pane；代价是宿主降级时（pane/tab 创建慢）
	 * 后续分配最长等 60 秒，这是保布局正确性的有意取舍；shell 握手与 agent 启动已在队外并行。
	 */
	private async allocateWorker(
		ctx: ExtensionContext,
		options: StartWorkerOptions,
		pending?: AbortController,
	): Promise<WorkerLaunch> {
		// 排队期间被 stop：在任何解析与副作用之前短路，休眠引用可能已被 forget。
		if (pending?.signal.aborted || this.lifecycle.signal.aborted)
			throw new Error("启动在排队阶段已被停止");
		const prompt = requiredText(options.prompt, "prompt");
		const referenced = options.session
			? this.store.state.workers.find(
				(worker) => worker.name === options.session || worker.sessionPath === options.session,
			)
			: undefined;
		if (referenced && referenced.status !== "dormant")
			throw new Error(`${referenced.name} 仍是 ${referenced.status}，无需恢复`);
		const dormant = referenced;
		const name = options.name?.trim() || dormant?.name;
		if (!name) throw new Error("start 需要 worker 名：用简短任务词命名（如 fix-outcome、scan-dups）");
		validateWorkerName(name);
		const existing = this.store.state.workers.find((worker) => worker.name === name);
		if (existing && existing !== dormant) throw new Error(`子代理已存在：${name}`);
		// 选型由工具层的选型门禁负责；这里只兜住休眠档案，缺失即报错——任何默认值都是替调用方静默花钱。
		const model = options.model?.trim() || dormant?.model;
		if (!model) throw new Error("start 需要 model：从选型表挑一个，或传休眠子代理名/session 沿用其档案");
		const thinking = parseThinking(options.thinking) ?? dormant?.thinking;
		if (!thinking) throw new Error("start 需要 thinking：按任务深浅显式定档，或传休眠子代理名/session 沿用其档案");
		const sessionPath = dormant?.sessionPath ?? options.session?.trim();
		// cwd 校验失败即拒绝：静默回退 Master 目录会让子代理在错误的 checkout 真实动手。
		const cwd = await resolveWorkerCwd(options.cwd ?? dormant?.cwd);
		const previous = dormant;
		if (dormant && dormant.name !== name)
			this.store.dispatch({ type: "REMOVE_WORKER", name: dormant.name });
		const provisional: WorkerRef = {
			name,
			model,
			thinking,
			status: "starting",
			paneId: "starting",
			tabId: "starting",
			...(sessionPath ? { sessionPath } : {}),
			...(cwd ? { cwd } : {}),
			...(options.review || dormant?.reviewNeeded ? { reviewNeeded: true } : {}),
		};
		// 启动也注册进 runs：stop/shutdown 能中止在飞启动，不只是监听；排队期被 stop 的直接短路。
		const startController = pending ?? new AbortController();
		if (startController.signal.aborted || this.lifecycle.signal.aborted)
			throw new Error(`${name} 启动在排队阶段已被停止`);
		this.store.dispatch({ type: "UPSERT_WORKER", worker: provisional });
		this.runs.set(name, startController);
		const signal = AbortSignal.any([this.lifecycle.signal, startController.signal]);
		let shellReady: Awaited<ReturnType<typeof createShellReadyMarker>> | undefined;
		try {
			shellReady = await createShellReadyMarker();
			const shell = await this.createWorkerShell(cwd ?? ctx.cwd, name, displayName(name, model), shellReady, signal);
			this.store.dispatch({
				type: "UPSERT_WORKER",
				worker: { ...provisional, paneId: shell.paneId, tabId: shell.tabId },
			});
			return { provisional, prompt, model, thinking, sessionPath, previous, shell, shellReady, controller: startController, signal };
		} catch (error) {
			await this.abandonStart(name, previous, undefined, startController);
			if (shellReady) await this.removeShellReady(name, shellReady);
			throw error;
		}
	}

	/** 串行区之外的长尾巴：shell 握手、agent 启动与监听，多个启动并行执行。 */
	private async launchWorker(launch: WorkerLaunch): Promise<WorkerRef> {
		const name = launch.provisional.name;
		try {
			await this.waitForShell(launch.shell.paneId, launch.shellReady.marker, launch.signal);
			const worker = await this.startAgent(
				launch.provisional,
				launch.shell.paneId,
				launch.model,
				launch.thinking,
				launch.sessionPath,
				launch.signal,
			);
			if (this.runs.get(name) === launch.controller) this.runs.delete(name);
			void this.monitorPrompt(worker, launch.prompt);
			return worker;
		} catch (error) {
			await this.abandonStart(name, launch.previous, launch.shell, launch.controller);
			throw error;
		} finally {
			if (this.runs.get(name) === launch.controller) this.runs.delete(name);
			await this.removeShellReady(name, launch.shellReady);
		}
	}

	private async abandonStart(
		name: string,
		previous: WorkerRef | undefined,
		shell: WorkerShell | undefined,
		controller: AbortController,
	): Promise<void> {
		// 池关闭（reload/退出）：零副作用——不关 shell、不写状态。reload 要保留子代理现场
		// 交给下个运行时 reconcile；off/quit 的实体清理由 cleanup() 的 stop 负责。
		if (this.lifecycle.signal.aborted) return;
		if (shell) {
			try {
				await this.closeWorkerShell(shell, name);
			} catch (cleanupError) {
				this.notifyMaster(`子代理 ${name} 启动失败后的 pane 清理也失败：${String(cleanupError)}`);
			}
		}
		this.store.dispatch({ type: "REMOVE_WORKER", name });
		// 回写策略按停止意图分流：自然失败与默认 stop 都恢复原休眠引用（契约：stop 保留
		// Dormant）；forget 与池关闭不回写，清理完成后的状态必须保持空。
		const reason = controller.signal.aborted
			? (controller.signal.reason as { keepDormant?: boolean } | undefined)
			: undefined;
		const keep = !controller.signal.aborted || reason?.keepDormant === true;
		if (previous && !this.lifecycle.signal.aborted && keep)
			this.store.dispatch({ type: "UPSERT_WORKER", worker: previous });
	}

	private async removeShellReady(
		name: string,
		shellReady: Awaited<ReturnType<typeof createShellReadyMarker>>,
	): Promise<void> {
		try {
			await rm(shellReady.directory, { recursive: true, force: true });
		} catch (error) {
			this.notifyMaster(`子代理 ${name} 的临时 shell 配置清理失败：${String(error)}`);
		}
	}

	async send(workerName: string, prompt: string, review = false): Promise<void> {
		const worker = requireWorker(this.store.state, workerName);
		if (worker.status === "reviewing")
			throw new Error(`${worker.name} 正在对抗审查，期间不能接收消息`);
		if (worker.status !== "idle" && worker.status !== "blocked")
			throw new Error(`${worker.name} 当前是 ${worker.status}，不能接收消息${worker.status === "working" ? "；要中途改方向先 interrupt，中断事件回来后再 send" : ""}`);
		// blocked（提问）时 send 是回答通道必须放行；idle 且审查意图未消耗 = 自动审查投递窗口，追问会撞审查。
		// 中断态（interruptedAt 在档）不是投递窗口——中断不触发自动补审，send 正是续跑通道（ADR-0006）。
		if (worker.status === "idle" && worker.reviewNeeded && !worker.interruptedAt)
			throw new Error(`${worker.name} 是待自动审查的审查票，等待审查终态后再发送（或先手动 review）`);
		const text = requiredText(prompt, "prompt");
		validateDelegationText(text);
		// 追问接管监听权：中断续监让位，同名监听只能有一个；发落标记与中断时刻随之消耗。
		this.runs.get(worker.name)?.abort();
		this.runs.delete(worker.name);
		const { disposition: _disposed, interruptedAt: _resumed, ...rest } = worker;
		// send 也能声明审查票：追加的重要实现工作与 start 委派同权，落定后走同一条自动补审路径。
		const active = { ...rest, status: "working" as const, ...(review ? { reviewNeeded: true } : {}) };
		this.store.dispatch({ type: "UPSERT_WORKER", worker: active });
		void this.monitorPrompt(active, text);
	}

	/**
	 * 打断 working 子代理的当前回合（会话与 pane 保留）：发 esc，与用户亲手中断走同一条
	 * 中断结算路径（idle + interruptedAt，send 放行），就绪信号经中断事件异步回传。
	 * esc 与回合自然结束的竞态无害：esc 落在空闲界面无副作用，结算按正常完成回传，
	 * 在飞标记随任意结算消费，不会污染下一次中断的归因。
	 */
	async interrupt(workerName: string): Promise<void> {
		const worker = requireWorker(this.store.state, workerName);
		if (worker.status !== "working")
			throw new Error(`${worker.name} 当前是 ${worker.status}，只有 working 子代理可以中断`);
		this.deliberateInterrupts.add(worker.name);
		try {
			await this.run("agent.send-keys(esc)", ["agent", "send-keys", requiredPane(worker), "esc"], 10_000);
		} catch (error) {
			this.deliberateInterrupts.delete(worker.name);
			throw error;
		}
	}

	/**
	 * 近况：最近一次外部输入之后的执行轨迹。只读快照——不改状态机、不消耗发落、不是进度接口。
	 * starting 之外全状态可读（休眠子代理的会话文件仍在磁盘上）。
	 */
	async tail(workerName: string): Promise<string> {
		const worker = requireWorker(this.store.state, workerName);
		if (!worker.sessionPath) throw new Error(`${worker.name} 仍在启动，还没有会话可读`);
		const trace = await readWorkerTrace(worker.sessionPath);
		return `子代理 ${worker.name} 近况（${worker.status}）\n${trace}`;
	}

	async review(workerName: string): Promise<void> {
		const worker = requireWorker(this.store.state, workerName);
		if (worker.status !== "idle") throw new Error(`${worker.name} 当前是 ${worker.status}，只有 idle Worker 可以审查`);
		const previousRunId = worker.sessionPath
			? reviewRunId(readReviewOutcome(worker.sessionPath)) ?? null
			: null;
		// 投递窗口纳入 stop 的中止范围：idle Worker 只可能挂着中断续监，先让它退位；
		// 不注册的话 stop 中止不到在飞投递，迟到返回会复活已休眠的 Worker。
		this.runs.get(worker.name)?.abort();
		this.runs.delete(worker.name);
		const controller = new AbortController();
		const signal = AbortSignal.any([this.lifecycle.signal, controller.signal]);
		this.runs.set(worker.name, controller);
		// --wait 要求投递后观察到状态变化才返回：堵住“投递后 Worker 短暂仍报 idle、
		// 后续监听立即结算误报审查未启动”的竞态。审查启动后状态为 working（命令回合）或 blocked（占用信号）。
		try {
			await this.run("agent.prompt(review)", [
				"agent", "prompt", requiredPane(worker), "/fire-review",
				"--wait", "--until", "working", "--until", "blocked", "--timeout", "8000",
			], 15_000, signal);
		} catch (error) {
			if (!isPromptStall(error)) throw this.reviewDeliveryFailure(worker.name, controller, error);
			// 占用信号失效时会话可能全程观察不到状态变化：以 runId 是否推进判定审查是否真的启动。
			const observed = worker.sessionPath
				? reviewRunId(readReviewOutcome(worker.sessionPath)) ?? null
				: null;
			if (observed === previousRunId)
				throw this.reviewDeliveryFailure(
					worker.name,
					controller,
					new Error(`${worker.name} 审查未启动：投递后状态与 fire-review runId 均无变化`),
				);
		} finally {
			if (this.runs.get(worker.name) === controller) this.runs.delete(worker.name);
		}
		// 迟到返回不得复活已停止 Worker：dispatch 前重读当前身份（与 handleSettlement 同模式），
		// 已休眠/移除/中止即放弃写入——意图仍在档案里，休眠恢复路径会续上补审。
		const current = currentWorkerRun(this.store.state.workers, worker);
		if (signal.aborted || !current || current.status !== "idle") return;
		// 审查意图在此消耗：只有确认审查真正启动（状态变化或 runId 推进）才算送达，
		// 投递失败时意图保留在档案里，由 reload/resume 自动重试或手动 review 兜底。
		const { reviewNeeded: _consumed, disposition: _disposed, interruptedAt: _resumed, ...launched } = current;
		const reviewing = {
			...launched,
			status: "reviewing" as const,
			reviewPreviousRunId: previousRunId,
		};
		this.store.dispatch({ type: "UPSERT_WORKER", worker: reviewing });
		void this.monitorReview(reviewing);
	}

	async stop(workerName: string, forget = false): Promise<void> {
		// interrupt 的在飞标记随监听一并作废：结算被此处 abort 后不再执行，残留标记会把
		// 同名子代理下次的外部中断误标为指令中断。
		this.deliberateInterrupts.delete(workerName);
		// 无条件中止该名字的在飞/排队任务：休眠分支也不能跳过。
		// 停止意图随 abort reason 传给清理路径：默认 stop 保留原休眠引用，forget 才删。
		const pending = this.runs.get(workerName);
		pending?.abort({ keepDormant: !forget });
		this.runs.delete(workerName);
		const existing = this.store.state.workers.find((candidate) => candidate.name === workerName);
		if (!existing) {
			if (pending) return;
			throw new Error(`子代理不存在：${workerName}`);
		}
		const worker = existing;
		if (worker.status !== "dormant") await this.closeOwnedWorker(worker);
		if (forget || !worker.sessionPath) {
			this.store.dispatch({ type: "REMOVE_WORKER", name: worker.name });
			return;
		}
		this.store.dispatch({ type: "UPSERT_WORKER", worker: dormantWorker(worker) });
	}

	async resume(): Promise<void> {
		for (const worker of liveWorkers(this.store.state)) {
			if (this.runs.has(worker.name)) continue;
			await this.reconcile(worker);
		}
	}

	async cleanup(): Promise<string[]> {
		const failures: string[] = [];
		for (const worker of [...this.store.state.workers]) {
			try {
				await this.stop(worker.name, true);
			} catch (error) {
				failures.push(`${worker.name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return failures;
	}

	async shutdown(): Promise<void> {
		this.lifecycle.abort();
		for (const controller of this.runs.values()) controller.abort();
		this.runs.clear();
		// 等在飞启动真正退出：reload 后新实例才恢复，避免新旧运行时交错写同一状态文件。
		await Promise.allSettled([this.startQueue, ...this.launches]);
	}

	private async createWorkerShell(
		cwd: string,
		name: string,
		display: string,
		shellReady: Awaited<ReturnType<typeof createShellReadyMarker>>,
		signal?: AbortSignal,
	): Promise<WorkerShell> {
		// 恢复与新建同一套布局：cwd 随档案持久化，pane 级 --cwd 支持混住同一 tab。
		const plan = this.splitPlan();
		if (plan) {
			try {
				const created = await this.run("pane.split", [
					"pane", "split", requiredPane(plan.target), "--direction", plan.direction, "--cwd", cwd,
					...workerShellEnv(name, shellReady), "--no-focus",
				], 60_000, signal);
				const pane = nestedRecord(created, ["result", "pane"]);
				const paneId = requiredField(pane, "pane_id", "pane.split.pane");
				await this.renamePane(paneId, display);
				// tab 从“首子代理专属”变成分组：标签改组名，不再冒用首子代理的名字。
				await this.renameTab(plan.target.tabId, "子代理");
				return { paneId, tabId: plan.target.tabId, close: "pane" };
			} catch (error) {
				// Layout is best-effort: a fresh tab keeps Worker startup independent of split support.
				// 但中止不是布局失败，不得退化继续建 tab。
				if (signal?.aborted) throw error;
			}
		}
		const created = await this.run("tab.create", [
			"tab", "create", "--workspace", this.workspaceId, "--cwd", cwd, "--label", display,
			...workerShellEnv(name, shellReady), "--no-focus",
		], 60_000, signal);
		const rootPane = nestedRecord(created, ["result", "root_pane"]);
		const tab = nestedRecord(created, ["result", "tab"]);
		const paneId = requiredField(rootPane, "pane_id", "tab.create.root_pane");
		await this.renamePane(paneId, display);
		return {
			paneId,
			tabId: requiredField(tab, "tab_id", "tab.create.tab"),
			close: "tab",
		};
	}

	/** pane 命名纯属显示，失败不影响 Worker 启动，但要告知 Master。 */
	private async renamePane(paneId: string, label: string): Promise<void> {
		try {
			await this.run("pane.rename", ["pane", "rename", paneId, label]);
		} catch (error) {
			this.notifyMaster(`pane 命名失败（不影响子代理）：${String(error)}`);
		}
	}

	/** tab 命名同样纯属显示，失败只通知。 */
	private async renameTab(tabId: string, label: string): Promise<void> {
		try {
			await this.run("tab.rename", ["tab", "rename", tabId, label]);
		} catch (error) {
			this.notifyMaster(`tab 命名失败（不影响子代理）：${String(error)}`);
		}
	}

	/**
	 * 2×2 象限布局：第 2 个右切首 pane，第 3 个下切首 pane，第 4 个下切第 2 个 pane。
	 * 嵌套同向切会把后来者挤成 1/8 宽，象限切保证四个 Worker 各占四分之一。
	 */
	private splitPlan(): { target: PositionedWorker; direction: "right" | "down" } | undefined {
		const positioned = liveWorkers(this.store.state).filter(hasPaneLocation);
		const latest = positioned.at(-1);
		if (!latest) return undefined;
		const occupants = positioned.filter((worker) => worker.tabId === latest.tabId);
		if (occupants.length >= MAX_WORKERS_PER_TAB) return undefined;
		if (occupants.length === 1) return { target: occupants[0], direction: "right" };
		if (occupants.length === 2) return { target: occupants[0], direction: "down" };
		return { target: occupants[1], direction: "down" };
	}

	private async startAgent(
		provisional: WorkerRef,
		paneId: string,
		model: string,
		thinking: WorkerThinking,
		sessionPath?: string,
		signal?: AbortSignal,
	): Promise<WorkerRef> {
		const args = [
			"agent",
			"start",
			agentName(provisional.name, model),
			"--kind",
			"pi",
			"--pane",
			paneId,
			"--timeout",
			"60000",
			"--",
			"--name",
			`↳${displayName(provisional.name, model)}`,
			"--model",
			model,
			"--thinking",
			thinking,
		];
		if (sessionPath) args.push("--session", sessionPath);
		const agent = parseAgent(await this.startAgentProcess(args, paneId, signal));
		const worker: WorkerRef = {
			name: provisional.name,
			paneId: agent.pane_id,
			tabId: agent.tab_id,
			sessionPath: requireSessionPath(agent),
			model,
			thinking,
			status: "working",
			...(provisional.cwd ? { cwd: provisional.cwd } : {}),
			...(provisional.reviewNeeded ? { reviewNeeded: true } : {}),
		};
		this.store.dispatch({ type: "UPSERT_WORKER", worker });
		return worker;
	}

	/** agent.start 对 agent_pane_busy 退避重试；窗口用尽后附 pane 前台快照作诊断证据。 */
	private async startAgentProcess(
		args: string[],
		paneId: string,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const deadline = Date.now() + START_BUSY_RETRY_WINDOW_MS;
		let delay = 500;
		while (true) {
			try {
				return await this.run("agent.start", args, 90_000, signal);
			} catch (error) {
				if (!isPaneBusy(error) || signal?.aborted) throw error;
				if (Date.now() + delay >= deadline) throw await this.withPaneEvidence(error, paneId);
				await retryDelay(delay, signal ?? this.lifecycle.signal);
				delay = Math.min(delay * 2, 4_000);
			}
		}
	}

	private async withPaneEvidence(error: unknown, paneId: string): Promise<Error> {
		let evidence: string;
		try {
			const response = await this.run("pane.process-info", ["pane", "process-info", "--pane", paneId], 5_000);
			evidence = JSON.stringify(nestedRecord(response, ["result"]).process_info ?? null);
		} catch (probeError) {
			evidence = `获取失败：${String(probeError)}`;
		}
		const message = error instanceof Error ? error.message : String(error);
		return new Error(`${message}（重试 ${START_BUSY_RETRY_WINDOW_MS / 1000}s 后仍 busy；pane 前台快照：${evidence}）`);
	}

	private async waitForShell(paneId: string, marker: string, signal?: AbortSignal): Promise<void> {
		await this.run("pane.wait-output(shell ready)", [
			"pane",
			"wait-output",
			paneId,
			"--match",
			marker,
			"--source",
			"recent-unwrapped",
			"--lines",
			"120",
			"--timeout",
			"60000",
		], 65_000, signal);
	}

	private async reconcile(worker: WorkerRef): Promise<void> {
		const live = await this.findLiveAgent(worker);
		if (!live) {
			if (worker.status === "starting") await this.closeStartingShell(worker);
			this.makeDormantOrForget(worker, "子代理进程已不存在");
			return;
		}
		const sessionPath = optionalSessionPath(live);
		if (!sessionPath || (worker.sessionPath && worker.sessionPath !== sessionPath)) {
			this.makeDormantOrForget(worker, "Worker session 身份已变化");
			return;
		}
		const refreshed: WorkerRef = {
			...worker,
			paneId: live.pane_id,
			tabId: live.tab_id,
			sessionPath,
			status: reconciledStatus(worker.status),
		};
		this.store.dispatch({ type: "UPSERT_WORKER", worker: refreshed });
		if (refreshed.status === "reviewing") void this.monitorReview(refreshed);
		else if (refreshed.status === "working") void this.monitorWait(refreshed);
		// 中断现场恢复：续监与剩余续跑计时一并重挂（ADR-0006）。
		else if (refreshed.status === "idle" && refreshed.interruptedAt) this.watchInterrupted(refreshed);
		// reload 落在自动审查投递窗口内：意图仍在档案里，凭它续上被打断的补审。
		else if (refreshed.status === "idle" && refreshed.reviewNeeded) void this.autoReview(refreshed.name);
	}

	private makeDormantOrForget(worker: WorkerRef, reason: string): void {
		if (worker.sessionPath)
			this.store.dispatch({ type: "UPSERT_WORKER", worker: dormantWorker(worker) });
		else this.store.dispatch({ type: "REMOVE_WORKER", name: worker.name });
		this.notifyMaster(`${worker.name} ${reason}`);
	}

	private async findLiveAgent(worker: WorkerRef): Promise<HerdrAgent | undefined> {
		const label = agentName(worker.name, worker.model);
		const targets = worker.paneId && worker.paneId !== "starting" ? [worker.paneId, label] : [label];
		for (const target of targets) {
			try {
				return parseAgent(await this.run("agent.get(reconcile)", ["agent", "get", target]));
			} catch (error) {
				if (!isMissingAgent(error)) throw error;
			}
		}
		return undefined;
	}

	private async closeStartingShell(worker: WorkerRef): Promise<void> {
		const tabId = await this.findStartingTab(displayName(worker.name, worker.model));
		if (tabId) await this.closeTab(tabId);
		else if (worker.paneId && worker.paneId !== "starting") await this.closePane(worker.paneId);
	}

	private async findStartingTab(label: string): Promise<string | undefined> {
		const response = await this.run("tab.list(reconcile)", ["tab", "list", "--workspace", this.workspaceId]);
		const matches = parseTabs(response).filter((tab) => tab.label === label);
		if (matches.length > 1) {
			this.notifyMaster(`${label} 有多个同名启动残留，未自动关闭`);
			return undefined;
		}
		return matches[0]?.tab_id;
	}

	private monitorPrompt(worker: WorkerRef, prompt: string): Promise<void> {
		return this.monitorSettlement(worker, "agent.prompt", [
			"agent", "prompt", requiredPane(worker), prompt, "--wait",
		], "work");
	}

	private monitorWait(worker: WorkerRef): Promise<void> {
		return this.monitorSettlement(worker, "agent.wait", settlementWaitArgs(worker), "work");
	}

	private monitorReview(worker: WorkerRef): Promise<void> {
		return this.monitorSettlement(
			worker,
			"agent.wait(review)",
			reviewWaitArgs(worker),
			"review",
			worker.reviewPreviousRunId,
		);
	}

	private async monitorSettlement(
		worker: WorkerRef,
		operation: string,
		args: string[],
		mode: "work" | "review",
		previousReviewRunId?: string | null,
	): Promise<void> {
		const controller = new AbortController();
		this.runs.set(worker.name, controller);
		let failures = 0;
		try {
			while (!controller.signal.aborted) {
				try {
					const settlement = await this.run(operation, args, null, controller.signal);
					if (controller.signal.aborted) return;
					if (mode === "review") {
						const finished = await this.handleReviewSettlement(
							worker,
							settlement,
							controller.signal,
							previousReviewRunId,
						);
						if (finished) return;
						// 审查仍在循环却观测到 idle：占用信号失效时没有事件可等，
						// 这里是有意的轮询兑底：退避后重挂等待直到审查落终态。
						operation = "agent.wait(review)";
						args = reviewWaitArgs(worker);
						await retryDelay(REVIEW_POLL_DELAY_MS, controller.signal);
						continue;
					}
					const verdict = await this.handleSettlement(worker, settlement, controller.signal);
					if (verdict === "done") return;
					// 外部发起的审查占用态不是终态：换用跳过 blocked 的等待直到审查落终态。
					operation = "agent.wait(review)";
					args = reviewWaitArgs(worker);
					continue;
				} catch (error) {
					if (controller.signal.aborted) return;
					const current = currentWorkerRun(this.store.state.workers, worker);
					if (!current || current.status === "dormant") return;
					if (isMissingAgent(error)) {
						this.makeDormantOrForget(current, "子代理进程已不存在");
						return;
					}
					if (failures === 0)
						this.notifyMaster(`子代理 ${worker.name} ${mode === "review" ? "审查" : ""}监听失败，正在恢复：${error instanceof Error ? error.message : String(error)}`);
					else await retryDelay(Math.min(1000 * 2 ** (failures - 1), MAX_RETRY_DELAY_MS), controller.signal);
					failures += 1;
					operation = mode === "review" ? "agent.wait(review)" : "agent.wait";
					args = mode === "review" ? reviewWaitArgs(worker) : settlementWaitArgs(worker);
				}
			}
		} finally {
			if (this.runs.get(worker.name) === controller) this.runs.delete(worker.name);
		}
	}

	/** 工作结算裁定：done=已终结；reviewing=外部发起的审查占用中，继续等终态。 */
	private async handleSettlement(
		worker: WorkerRef,
		response: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<"done" | "reviewing"> {
		const agent = parseAgent(response);
		const status = settlementStatus(agent);
		const current = currentWorkerRun(this.store.state.workers, worker);
		if (!current || current.status === "dormant") return "done";
		if (status === "blocked") {
			const label = stateLabel(agent);
			// 审查占用（如用户外部手动 /fire-review）不是 Worker 提问：转 reviewing 继续等终态。
			if (label?.includes(REVIEW_OCCUPANCY_LABEL)) {
				this.store.dispatch({ type: "UPSERT_WORKER", worker: { ...current, status: "reviewing" } });
				return "reviewing";
			}
			const question = label ?? (await readLatestAssistant(current.sessionPath))?.text;
			if (signal.aborted) return "done";
			const blocked = currentWorkerRun(this.store.state.workers, worker);
			if (!blocked || blocked.status === "dormant") return "done";
			this.store.dispatch({ type: "UPSERT_WORKER", worker: { ...blocked, status } });
			this.notifyMaster(workerBlockedText(blocked, question));
			return "done";
		}
		const latest = await this.latest(worker);
		// 任意结算都消费在飞标记：esc 未命中（回合恰好自然结束）时标记不得残留到下次中断。
		const deliberate = this.deliberateInterrupts.delete(worker.name);
		if (signal.aborted) return "done";
		const settled = currentWorkerRun(this.store.state.workers, worker);
		if (!settled || settled.status === "dormant") return "done";
		if (latest && isInterrupted(latest)) {
			// 中断不是执行失败：不消耗审查意图，续监动静，无人接手再交还指挥官（ADR-0006）。
			const interrupted: WorkerRef = { ...settled, status: "idle", interruptedAt: Date.now() };
			this.store.dispatch({ type: "UPSERT_WORKER", worker: interrupted });
			this.notifyMaster(workerInterruptedText(interrupted, latest, deliberate), interrupted.name);
			this.watchInterrupted(interrupted);
			return "done";
		}
		// 意图不在此消耗：只有 review() 确认启动才消耗，失败与 reload 都能凭档案重试。
		this.store.dispatch({ type: "UPSERT_WORKER", worker: { ...settled, status: "idle" } });
		if (!latest || latest.stopReason !== "stop" || latest.errorMessage) {
			this.notifyMaster(workerFailureText(settled, latest, settled.reviewNeeded
				? "审查票：执行失败未发起自动审查，意图保留"
				: undefined), settled.name);
			return "done";
		}
		if (settled.reviewNeeded) {
			// 先如实回传「将发起」，成功与否由 review()/autoReview 各自落地，不提前宣称已启动。
			this.notifyMaster(workerResultText(settled, latest, "审查票：将自动发起对抗审查，终态另行回传"), settled.name);
			await this.autoReview(settled.name);
			return "done";
		}
		this.notifyMaster(workerResultText(settled, latest), settled.name);
		return "done";
	}

	/**
	 * review 投递失败收尾：先释放本次投递的监听位（finally 的清理在 throw 后才跑，
	 * 不先删会挡住重挂），再把中断态子代理挂回续监——否则监视与计时承诺断到下次 reload。
	 */
	private reviewDeliveryFailure(name: string, controller: AbortController, error: unknown): unknown {
		if (this.runs.get(name) === controller) this.runs.delete(name);
		const current = this.store.state.workers.find((candidate) => candidate.name === name);
		if (current?.status === "idle" && current.interruptedAt && !this.runs.has(name))
			this.watchInterrupted(current);
		return error;
	}

	/** 中断续监：用户接手（working）则结果照常回流；五分钟无动静把流程交还指挥官。 */
	private watchInterrupted(worker: WorkerRef): void {
		const controller = new AbortController();
		this.runs.set(worker.name, controller);
		const signal = AbortSignal.any([this.lifecycle.signal, controller.signal]);
		this.armAutoResume(worker, signal);
		void this.runInterruptWatch(worker, controller, signal);
	}

	private armAutoResume(worker: WorkerRef, signal: AbortSignal): void {
		const delay = Math.max(0, (worker.interruptedAt ?? 0) + INTERRUPT_RESUME_DELAY_MS - Date.now());
		const timer = setTimeout(() => {
			const current = currentWorkerRun(this.store.state.workers, worker);
			if (signal.aborted || !current || current.status !== "idle" || current.interruptedAt !== worker.interruptedAt)
				return;
			// 中断时刻不在此消耗：它是"中断态"的唯一标记，send 门禁豁免与续监都凭它识别，
			// 直到接手（send/review/用户派活）才清；本轮定时器已烧尽，不会重复提醒（reload 重挂除外）。
			this.notifyMaster(autoResumeText(current), current.name);
		}, delay);
		timer.unref?.();
		signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
	}

	private async runInterruptWatch(worker: WorkerRef, controller: AbortController, signal: AbortSignal): Promise<void> {
		let failures = 0;
		try {
			while (!signal.aborted) {
				try {
					await this.run("agent.wait(interrupted)", [
						"agent", "wait", requiredPane(worker), "--until", "working",
					], null, signal);
					if (signal.aborted) return;
					const current = currentWorkerRun(this.store.state.workers, worker);
					if (!current || current.status !== "idle") return;
					const { interruptedAt: _resumed, ...rest } = current;
					const resumed: WorkerRef = { ...rest, status: "working" };
					this.store.dispatch({ type: "UPSERT_WORKER", worker: resumed });
					if (this.runs.get(worker.name) === controller) this.runs.delete(worker.name);
					// 接手后自毁：清掉自动续跑定时器，落定监听交给 monitorWait。
					controller.abort();
					void this.monitorWait(resumed);
					return;
				} catch (error) {
					if (signal.aborted) return;
					const current = currentWorkerRun(this.store.state.workers, worker);
					if (!current || current.status !== "idle") return;
					if (isMissingAgent(error)) {
						this.makeDormantOrForget(current, "子代理进程已不存在");
						return;
					}
					await retryDelay(Math.min(1000 * 2 ** failures, MAX_RETRY_DELAY_MS), signal);
					failures += 1;
				}
			}
		} finally {
			if (this.runs.get(worker.name) === controller) this.runs.delete(worker.name);
		}
	}

	/** 审查票自动补审：意图只在 review() 成功转入 reviewing 时消耗；失败保留意图待重试。 */
	private async autoReview(name: string): Promise<void> {
		try {
			await this.review(name);
		} catch (error) {
			this.notifyMaster(
				`子代理 ${name} 自动审查发起失败（意图保留，reload 后自动重试，也可手动 review）：${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/** 返回审查监听是否已终结；false 表示审查仍在循环，调用方需重挂等待。 */
	private async handleReviewSettlement(
		worker: WorkerRef,
		response: Record<string, unknown>,
		signal: AbortSignal,
		previousRunId?: string | null,
	): Promise<boolean> {
		const status = settlementStatus(parseAgent(response));
		if (status === "blocked") throw new Error("Herdr 审查等待错误返回 blocked");
		const latest = await this.latest(worker);
		if (signal.aborted) return true;
		const settled = currentWorkerRun(this.store.state.workers, worker);
		if (!settled || settled.status !== "reviewing") return true;
		const observed: ReviewOutcome = settled.sessionPath
			? readReviewOutcome(settled.sessionPath)
			: { status: "error", message: "子代理缺少 Pi session 路径" };
		const stale = previousRunId !== undefined && (reviewRunId(observed) ?? null) === previousRunId;
		// runId 已推进但仍在循环中：占用信号失效时轮间会观测到 idle，不能就此结算。
		if (!stale && observed.status === "in_progress") return false;
		const outcome: ReviewOutcome = stale
			? { status: "error", message: "审查未启动：未观察到新的 fire-review runId" }
			: observed;
		const { reviewPreviousRunId: _previousRunId, ...finished } = settled;
		this.store.dispatch({ type: "UPSERT_WORKER", worker: { ...finished, status: "idle" } });
		this.notifyMaster(reviewResultText(settled, outcome, latest), settled.name);
		return true;
	}

	private async latest(worker: WorkerRef): Promise<LatestAssistant | undefined> {
		const live = parseAgent(await this.run("agent.get", ["agent", "get", requiredPane(worker)]));
		return readLatestAssistant(requireSessionPath(live));
	}

	private async closeOwnedWorker(worker: WorkerRef): Promise<void> {
		const live = await this.findLiveAgent(worker);
		if (!live) {
			// agent 从未启动的 starting 壳（如 reload 遗留）也要收，共享 tab 只收自己的 pane。
			if (worker.paneId && worker.paneId !== "starting") {
				const shared = liveWorkers(this.store.state).some((candidate) =>
					candidate.name !== worker.name && candidate.tabId === worker.tabId
				);
				if (shared || !worker.tabId || worker.tabId === "starting") await this.closePane(worker.paneId);
				else await this.closeTab(worker.tabId);
			}
			return;
		}
		const sessionPath = optionalSessionPath(live);
		const owned = worker.sessionPath
			? sessionPath === worker.sessionPath
			: live.pane_id === worker.paneId && live.tab_id === worker.tabId;
		if (!owned) return;
		const sharedTab = liveWorkers(this.store.state).some((candidate) =>
			candidate.name !== worker.name && candidate.tabId === live.tab_id
		);
		if (sharedTab) await this.closePane(live.pane_id);
		else await this.closeTab(live.tab_id);
	}

	private async closeWorkerShell(shell: WorkerShell, ownerName?: string): Promise<void> {
		if (shell.close === "pane") return this.closePane(shell.paneId);
		// 开 tab 的首子代理被中止时，同 tab 可能已有并行启动的其他子代理：不能连坐关整 tab。
		const shared = liveWorkers(this.store.state).some((candidate) =>
			candidate.name !== ownerName && candidate.tabId === shell.tabId
		);
		if (shared) return this.closePane(shell.paneId);
		return this.closeTab(shell.tabId);
	}

	private async closePane(paneId: string): Promise<void> {
		if (!paneId || paneId === "starting") return;
		try {
			await this.run("pane.close", ["pane", "close", paneId]);
		} catch (error) {
			if (!String(error).includes("pane_not_found")) throw error;
		}
	}

	private async closeTab(tabId: string): Promise<void> {
		if (!tabId || tabId === "starting") return;
		try {
			await this.run("tab.close", ["tab", "close", tabId]);
		} catch (error) {
			if (!String(error).includes("tab_not_found")) throw error;
		}
	}

	private async run(
		operation: string,
		args: string[],
		timeout: number | null = 60_000,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const result = await this.pi.exec(process.env.HERDR_BIN_PATH ?? "herdr", args, {
			...(timeout === null ? {} : { timeout }),
			signal,
		});
		if (result.code !== 0) {
			const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
			throw new Error(`Herdr ${operation} 失败：${detail}`);
		}
		try {
			return JSON.parse(result.stdout) as Record<string, unknown>;
		} catch {
			throw new Error(`Herdr ${operation} 返回了无效 JSON`);
		}
	}
}

async function createShellReadyMarker(): Promise<{ directory: string; marker: string }> {
	if (!process.env.SHELL?.endsWith("/zsh")) throw new Error("Master Worker 当前只支持 zsh 启动握手");
	const directory = await mkdtemp(join(tmpdir(), "firecode-worker-shell-"));
	const marker = `firecode-shell-ready-${crypto.randomUUID()}`;
	try {
		await Promise.all([
			writeFile(join(directory, ".zshenv"), '[[ -f "$HOME/.zshenv" ]] && source "$HOME/.zshenv"\n'),
			writeFile(join(directory, ".zprofile"), '[[ -f "$HOME/.zprofile" ]] && source "$HOME/.zprofile"\n'),
			writeFile(join(directory, ".zshrc"), [
				'[[ -f "$HOME/.zshrc" ]] && source "$HOME/.zshrc"',
				"autoload -Uz add-zsh-hook",
				"function _firecode_shell_ready() {",
				'  print -r -- "$FIRECODE_SHELL_READY_MARKER"',
				"  add-zsh-hook -d precmd _firecode_shell_ready",
				"}",
				"add-zsh-hook precmd _firecode_shell_ready",
				"",
			].join("\n")),
		]);
		return { directory, marker };
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

function workerShellEnv(
	name: string,
	shellReady: Awaited<ReturnType<typeof createShellReadyMarker>>,
): string[] {
	return [
		"--env", `FIRECODE_MASTER_WORKER=${name}`,
		"--env", `FIRECODE_SHELL_READY_MARKER=${shellReady.marker}`,
		"--env", `ZDOTDIR=${shellReady.directory}`,
	];
}

function hasPaneLocation(worker: WorkerRef): worker is PositionedWorker {
	return !!worker.paneId && worker.paneId !== "starting" && !!worker.tabId && worker.tabId !== "starting";
}

function parseThinking(value?: string): WorkerThinking | undefined {
	if (!value) return undefined;
	if (THINKING_LEVELS.includes(value as WorkerThinking)) return value as WorkerThinking;
	throw new Error(`thinking 必须是 ${THINKING_LEVELS.join(" / ")}`);
}

function validateWorkerName(name: string): void {
	if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(name))
		throw new Error("Worker name 必须匹配 [a-z][a-z0-9_-]{0,31}");
}

function requiredText(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 不能为空`);
	return value.trim();
}

/** 委派技能白名单：目前仅 tdd（其余技能要么含自审与对抗审查冲突，要么属 solo 场景）。 */
const DELEGATION_SKILL_WHITELIST = ["/skill:tdd "];

/**
 * 提示词禁令实战失效（2026-08-16 夜跑 26 次 /skill:implement 委派）：纪律交给代码。
 * /skills? 前缀一律拦截（含拼写错误——静默失效比违规更糟），白名单外直接拒绝。
 */
function validateDelegationText(prompt: unknown): void {
	if (typeof prompt !== "string") return;
	const text = prompt.trimStart();
	if (!/^\/skills?:/u.test(text)) return;
	if (DELEGATION_SKILL_WHITELIST.some((allowed) => text.startsWith(allowed))) return;
	throw new Error(
		"委派文本的技能前缀被拒绝：只允许 /skill:tdd 。implement 内含自审、与自动对抗审查冲突；调查/文档/收口票用普通自包含说明；拼错的技能前缀会静默失效，同样拒绝。",
	);
}

function requiredPane(worker: WorkerRef): string {
	if (!worker.paneId || worker.paneId === "starting") throw new Error(`${worker.name} 缺少可用 pane`);
	return worker.paneId;
}

function parseAgent(response: Record<string, unknown>): HerdrAgent {
	const result = nestedRecord(response, ["result"]);
	const value = (result.agent ?? result) as unknown;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Herdr 响应缺少 agent");
	const agent = value as Record<string, unknown>;
	const name = agent.name;
	const stateLabels = stringRecord(agent.state_labels);
	return {
		pane_id: requiredField(agent, "pane_id", "agent"),
		tab_id: requiredField(agent, "tab_id", "agent"),
		...(typeof name === "string" || name === null ? { name } : {}),
		...(agent.agent_status === "idle" || agent.agent_status === "blocked" || agent.agent_status === "done"
			? { agent_status: agent.agent_status }
			: {}),
		...(stateLabels ? { state_labels: stateLabels } : {}),
		...(typeof agent.agent_session === "object" ? { agent_session: agent.agent_session as HerdrAgent["agent_session"] } : {}),
	};
}

function requireSessionPath(agent: HerdrAgent): string {
	const path = optionalSessionPath(agent);
	if (path) return path;
	throw new Error("Herdr 响应缺少持久 Pi session 路径");
}

function optionalSessionPath(agent: HerdrAgent): string | undefined {
	return agent.agent_session?.kind === "path" && typeof agent.agent_session.value === "string"
		? agent.agent_session.value
		: undefined;
}

function parseTabs(response: Record<string, unknown>): { tab_id: string; label?: string }[] {
	const tabs = nestedRecord(response, ["result"]).tabs;
	if (!Array.isArray(tabs)) throw new Error("Herdr 响应缺少 result.tabs");
	return tabs.map((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error("Herdr result.tabs 包含无效 tab");
		const tab = value as Record<string, unknown>;
		return {
			tab_id: requiredField(tab, "tab_id", "tab"),
			...(typeof tab.label === "string" ? { label: tab.label } : {}),
		};
	});
}

function isMissingAgent(error: unknown): boolean {
	return error instanceof Error && error.message.includes("agent_not_found");
}

function isPaneBusy(error: unknown): boolean {
	return error instanceof Error && error.message.includes("agent_pane_busy");
}

/** prompt --wait 在投递后未观察到状态变化时的两种超时形态。 */
function isPromptStall(error: unknown): boolean {
	const text = String(error);
	return text.includes("agent_prompt_stalled") || text.includes("timeout");
}

/** pane/tab/Pi 会话的统一显示名：任务名-模型名，一眼认出谁在干什么、用的什么。 */
function displayName(name: string, model: string): string {
	return `${name}-${model.split("/").pop()}`;
}

/**
 * Herdr agent 名硬约束 [a-z][a-z0-9_-]{0,31}：点号等字符降为 "-"；
 * 超长时裁任务词保模型尾——模型名被挤掉就违背“任务-模型一眼可见”。
 */
function agentName(name: string, model: string): string {
	const modelPart = sanitizeAgentChars(String(model.split("/").pop()));
	const task = sanitizeAgentChars(name);
	const taskBudget = 31 - modelPart.length;
	if (taskBudget < 1) return `${task}-${modelPart}`.slice(0, 32);
	return `${task.slice(0, taskBudget)}-${modelPart}`;
}

function sanitizeAgentChars(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9_-]/gu, "-");
}

async function readLatestAssistant(path?: string): Promise<LatestAssistant | undefined> {
	if (!path) return undefined;
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return undefined;
	}
	const nodes = new Map<string, { parentId?: string; assistant?: LatestAssistant }>();
	let leaf: string | undefined;
	for (const line of text.split("\n")) {
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (typeof entry.id !== "string") continue;
		const node: { parentId?: string; assistant?: LatestAssistant } = {};
		if (typeof entry.parentId === "string") node.parentId = entry.parentId;
		const message = entry.message;
		if (message && typeof message === "object" && !Array.isArray(message)) {
			const record = message as Record<string, unknown>;
			if (record.role === "assistant") {
				const assistant: LatestAssistant = { text: messageText(record.content) };
				if (typeof record.stopReason === "string") assistant.stopReason = record.stopReason;
				if (typeof record.errorMessage === "string") assistant.errorMessage = record.errorMessage;
				node.assistant = assistant;
			}
		}
		nodes.set(entry.id, node);
		leaf = entry.id;
	}
	const visited = new Set<string>();
	while (leaf && !visited.has(leaf)) {
		visited.add(leaf);
		const node = nodes.get(leaf);
		if (!node) break;
		if (node.assistant) return node.assistant;
		leaf = node.parentId;
	}
	return undefined;
}

/**
 * 近况提取：从叶子沿父链倒取，遇到最近一次外部输入（user 消息或审查注入）或预算用尽即止，谁先到算谁。
 * 停止原因提到最前（最短也最关键）；边界本身只带开头做锚点，否则读不懂轨迹在回应什么。
 */
async function readWorkerTrace(path: string): Promise<string> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		throw new Error(`读不到子代理会话文件（${path}）：${error instanceof Error ? error.message : String(error)}`);
	}
	const nodes = new Map<string, { parentId?: string; entry: Record<string, unknown> }>();
	let leaf: string | undefined;
	for (const line of text.split("\n")) {
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (typeof entry.id !== "string") continue;
		nodes.set(entry.id, { ...(typeof entry.parentId === "string" ? { parentId: entry.parentId } : {}), entry });
		leaf = entry.id;
	}
	const steps: string[] = [];
	const visited = new Set<string>();
	let budget = TRACE_BUDGET;
	let cursor = leaf;
	let status: string | undefined;
	let anchor: string | undefined;
	let exhausted = false;
	while (cursor && !visited.has(cursor)) {
		visited.add(cursor);
		const node = nodes.get(cursor);
		if (!node) break;
		anchor = traceAnchor(node.entry);
		if (anchor) break;
		status ??= traceStatus(node.entry);
		const step = traceStep(node.entry);
		if (step) {
			if (step.length > budget) {
				steps.push(`${step.slice(0, budget)}…`);
				exhausted = true;
				break;
			}
			budget -= step.length;
			steps.push(step);
		}
		cursor = node.parentId;
	}
	return [
		...(status ? [status] : []),
		anchor ?? (exhausted ? "…（更早内容已省略，预算用尽）" : "（会话开头）"),
		...steps.reverse(),
	].join("\n") + (steps.length ? "" : "\n（最近一次输入之后还没有任何输出）");
}

/** 倒取的停止边界：任何外部写入都算，子代理会话里的 custom_message 只有 fire-review 会发。 */
function traceAnchor(entry: Record<string, unknown>): string | undefined {
	// 正文走与普通消息同一条提取：宿主允许 content 是富内容数组，写死字符串会让锚点静默变空。
	if (entry.type === "custom_message")
		return `审查注入：${truncate(messageText(entry.content), TRACE_ANCHOR_LIMIT)}`;
	const message = messageRecord(entry);
	if (message?.role !== "user") return undefined;
	return `上一条指令：${truncate(messageText(message.content), TRACE_ANCHOR_LIMIT)}`;
}

/** 最新一条 assistant 的异常结尾；正常 stop 不入近况（无信息量）。 */
function traceStatus(entry: Record<string, unknown>): string | undefined {
	const message = messageRecord(entry);
	if (message?.role !== "assistant") return undefined;
	const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
	const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
	if (!errorMessage && (!stopReason || stopReason === "stop")) return undefined;
	return `状态：${stopReason ?? "?"}${errorMessage ? `｜${errorMessage}` : ""}`;
}

/** 一条会话条目渲染成轨迹行；thinking 与纯状态条目（checkpoint 等）不入近况。 */
function traceStep(entry: Record<string, unknown>): string | undefined {
	const message = messageRecord(entry);
	if (!message) return undefined;
	if (message.role === "toolResult") {
		const output = truncate(messageText(message.content), TRACE_ENTRY_LIMIT);
		return output ? `← ${output}` : undefined;
	}
	if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	const lines = message.content.flatMap((part) => {
		if (!part || typeof part !== "object" || Array.isArray(part)) return [];
		const record = part as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") return record.text ? [record.text] : [];
		if (record.type !== "toolCall") return [];
		const name = typeof record.name === "string" ? record.name : "?";
		return [`→ ${name} ${truncate(JSON.stringify(record.arguments ?? {}), TRACE_ENTRY_LIMIT)}`];
	});
	return lines.length ? lines.join("\n") : undefined;
}

function messageRecord(entry: Record<string, unknown>): Record<string, unknown> | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	return message && typeof message === "object" && !Array.isArray(message)
		? (message as Record<string, unknown>)
		: undefined;
}

function truncate(value: string, limit: number): string {
	return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part) => {
		if (!part || typeof part !== "object" || Array.isArray(part)) return [];
		const record = part as Record<string, unknown>;
		return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
	}).join("\n");
}

function currentWorkerRun(workers: WorkerRef[], expected: WorkerRef): WorkerRef | undefined {
	return workers.find((worker) =>
		worker.name === expected.name &&
		worker.paneId === expected.paneId &&
		worker.tabId === expected.tabId &&
		worker.sessionPath === expected.sessionPath
	);
}

function settlementStatus(agent: HerdrAgent): "idle" | "blocked" | "done" {
	const status = agent.agent_status;
	if (status) return status;
	throw new Error("Herdr 等待响应缺少有效 agent_status");
}

function dormantWorker(worker: WorkerRef): WorkerRef {
	if (!worker.sessionPath) throw new Error(`${worker.name} 缺少可恢复 session`);
	return {
		name: worker.name,
		model: worker.model,
		thinking: worker.thinking,
		status: "dormant",
		sessionPath: worker.sessionPath,
		// 工作目录与未消耗的审查意图随休眠保留：恢复后回到同一 checkout、仍会自动补审。
		...(worker.cwd ? { cwd: worker.cwd } : {}),
		...(worker.reviewNeeded ? { reviewNeeded: true } : {}),
	};
}

/** 中断识别：pi 自身信号中止记 aborted；经其它层浮出的中止是 error + abort 字样错误串。漏识别只退回失败分类，不伤流转。 */
function isInterrupted(latest: LatestAssistant): boolean {
	if (latest.stopReason === "aborted") return true;
	return latest.stopReason === "error" && /abort/iu.test(latest.errorMessage ?? "");
}

async function resolveWorkerCwd(requested?: string): Promise<string | undefined> {
	const path = requested?.trim();
	if (!path) return undefined;
	if (!isAbsolute(path)) throw new Error(`cwd 必须是绝对路径：${path}`);
	let real: string;
	try {
		real = await realpath(path);
	} catch {
		throw new Error(`cwd 目录不存在：${path}`);
	}
	if (!(await stat(real)).isDirectory()) throw new Error(`cwd 不是目录：${path}`);
	return real;
}

function workerInterruptedText(worker: WorkerRef, latest: LatestAssistant, deliberate: boolean): string {
	return [
		deliberate
			? `子代理 ${worker.name} 已按你的 interrupt 指令停下（回合中止，会话与上下文保留）`
			: `子代理 ${worker.name} 被中断（回合被外部中止，非执行失败）`,
		...(worker.reviewNeeded ? ["审查票：审查意图保留，正常完成后仍会自动补审。"] : []),
		latest.text ? `${sectionLine("lastOutput")}\n${bounded(latest.text)}` : "中断前没有输出。",
		deliberate
			? "send 继续或改方向；要留它待命就 ack 发落本条。插件持续盯着它：若五分钟无动静，你会另收到自动续跑提醒。"
			: "多半是用户手动介入想插话或改方向，少数情况是连接异常。不要重发任务，用 ack 发落本条即可；插件持续盯着它：用户直接派活的话，完成后你照常收到结果；若五分钟无任何动静，你会另收到自动续跑提醒。",
	].join("\n");
}

function autoResumeText(worker: WorkerRef): string {
	return [
		// 不断言中断来源：指令中断标记不持久，reload 后无法区分指令中断与意外中断。
		`子代理 ${worker.name} 中断后已 5 分钟无动静`,
		"流程交还给你：子代理上下文完整，用 send 让它从断点继续（一句「继续刚才被中断的工作」即可；审查票的 send 在中断态放行，审查意图不受影响；要调整方向就直接给新指令）；仍要搁置就 ack。无需与用户确认。",
	].join("\n");
}

function workerBlockedText(worker: WorkerRef, question?: string): string {
	return [
		`子代理 ${worker.name} 等待输入`,
		question ? `${sectionLine("question")}\n${bounded(question)}` : "子代理未提供具体问题，请检查对应 pane。",
		"用 subagents send 回答后继续。",
	].join("\n");
}

function reviewResultText(worker: WorkerRef, outcome: ReviewOutcome, latest: LatestAssistant | undefined): string {
	return [
		`子代理 ${worker.name} 审查结束：${reviewOutcomeText(outcome)}`,
		latest?.text ? `${sectionLine("finalReply")}\n${bounded(latest.text)}` : "最终回复为空。",
	].join("\n");
}

function reviewRunId(outcome: ReviewOutcome): string | undefined {
	return "runId" in outcome ? outcome.runId : undefined;
}

function reviewOutcomeText(outcome: ReviewOutcome): string {
	if (outcome.status === "passed") return `通过（${outcome.rounds} 轮）`;
	if (outcome.status === "stopped") {
		const first = outcome.advisorAdvice?.split(/\r?\n/u).find((line) => line.trim())?.trim();
		return `停止（${outcome.rounds} 轮${first ? `，顾问：${first.slice(0, 160)}` : ""}）`;
	}
	if (outcome.status === "failed") return `审查未完成（${outcome.reason}，第 ${outcome.rounds} 轮）`;
	if (outcome.status === "in_progress") return "判定异常（审查仍在进行中）";
	if (outcome.status === "none") return "判定异常（未找到审查）";
	return `判定读取失败（${outcome.message}）`;
}

function workerFailureText(
	worker: WorkerRef,
	latest: LatestAssistant | undefined,
	review?: string,
): string {
	const details = latest ? [
		latest.stopReason ? `停止原因：${latest.stopReason}` : undefined,
		latest.errorMessage,
		latest.text,
	].filter(Boolean).join("\n") : "未找到最终 assistant 回复";
	return [
		`子代理 ${worker.name} 执行失败`,
		...(review ? [review] : []),
		`${sectionLine("error")}\n${bounded(details)}`,
	].join("\n");
}

// 事件不携带模型/session 等静态身份：进场一次（start 返回值）、按需重查（list），事件只装增量信号。
function workerResultText(worker: WorkerRef, latest: LatestAssistant, review?: string): string {
	return [
		`子代理 ${worker.name} 已停下`,
		...(review ? [review] : []),
		latest.text ? `${sectionLine("reply")}\n${bounded(latest.text)}` : "回复为空。",
	].join("\n");
}

function bounded(value: string): string {
	return value.length > RESULT_CONTEXT_LIMIT
		? `${value.slice(0, RESULT_CONTEXT_LIMIT)}\n…（完整内容保留在 Worker session）`
		: value;
}

function settlementWaitArgs(worker: WorkerRef): string[] {
	return ["agent", "wait", requiredPane(worker)];
}

function reviewWaitArgs(worker: WorkerRef): string[] {
	return ["agent", "wait", requiredPane(worker), "--until", "idle", "--until", "done"];
}

function reconciledStatus(status: WorkerRef["status"]): WorkerRef["status"] {
	return status === "idle" || status === "blocked" || status === "reviewing" ? status : "working";
}

function retryDelay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const finish = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		timer.unref?.();
		signal.addEventListener("abort", finish, { once: true });
	});
}

function stateLabel(agent: HerdrAgent): string | undefined {
	const labels = Object.values(agent.state_labels ?? {}).filter((label) => label.trim());
	return labels.length ? [...new Set(labels)].join("\n") : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const entries = Object.entries(value);
	return entries.every((entry): entry is [string, string] => typeof entry[1] === "string")
		? Object.fromEntries(entries)
		: undefined;
}

function nestedRecord(value: unknown, path: string[]): Record<string, unknown> {
	let current = value;
	for (const key of path) {
		if (!current || typeof current !== "object" || Array.isArray(current))
			throw new Error(`Herdr 响应缺少 ${path.join(".")}`);
		current = (current as Record<string, unknown>)[key];
	}
	if (!current || typeof current !== "object" || Array.isArray(current))
		throw new Error(`Herdr 响应缺少 ${path.join(".")}`);
	return current as Record<string, unknown>;
}

function requiredField(value: Record<string, unknown>, key: string, path: string): string {
	const field = value[key];
	if (typeof field !== "string") throw new Error(`Herdr ${path}.${key} 必须是字符串`);
	return field;
}
