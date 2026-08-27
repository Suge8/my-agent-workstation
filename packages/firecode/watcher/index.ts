/**
 * Watcher 观察员：每个 turn 结束后异步评估主会话增量，要么沉默，要么发一条建议。
 * 与 Master、fire-review 各自独立注册；观察过程不落盘。
 */
import type { Model } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	ModelRuntime,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, type WatcherConfig } from "../config.js";
import { deliver } from "../deliver.js";
import { formatModelName } from "../format.js";
import { InProcessSessionPool } from "../master/spawn.js";
import {
	adviceMessage,
	registerWatcherCardRenderer,
	WATCHER_MESSAGE_TYPE,
	type WatcherCard,
} from "./card.js";
import { createObserver, type Advice, type Observer } from "./observer.js";
import { renderTurn } from "./transcript.js";

/** review 模块发布的占用频道；观察员只订阅，不参与审查状态机。 */
const REVIEW_OCCUPANCY_CHANNEL = "herdr:blocked";
/** 观察会话自身上下文占比超过此值即重建。 */
const CONTEXT_RESET_PERCENT = 70;

interface WatcherDependencies {
	resolveModel?: (id: string) => Promise<Model<any>>;
	pool?: InProcessSessionPool;
	createObserver?: typeof createObserver;
}

interface WatcherRuntime {
	ctx: ExtensionContext;
	pending: string[];
	lastTurnIndex: number;
	evaluating: boolean;
	observer?: Observer;
}

export function registerWatcher(
	pi: ExtensionAPI,
	dependencies: WatcherDependencies = {},
	subsession = false,
): void {
	// 子会话不带观察员：级联抑制是代码规则，不靠进程环境。
	if (subsession) return;
	registerWatcherCardRenderer(pi);
	const loaded = loadWatcherConfiguration();
	// 配置有问题时拒绝启动：静默回退会拿用户没配的模型真实发起观察。
	if ("error" in loaded) {
		pi.registerCommand("fire-watch", {
			description: "翻转当前会话的观察员开关",
			handler: async (args, ctx) => ctx.ui.notify(args.trim() ? "/fire-watch 不接受参数" : loaded.error, "error"),
		});
		return;
	}
	const config = loaded;
	const pool = dependencies.pool ?? new InProcessSessionPool();
	const spawnObserver = dependencies.createObserver ?? createObserver;
	let runtime: WatcherRuntime | undefined;
	let reviewActive = false;
	/** 重新入场计数：在途评估看的是旧现场，它的结果与故障都不再算数。 */
	let era = 0;

	const resetObserver = () => {
		if (!runtime) return;
		era += 1;
		runtime.observer?.dispose();
		runtime.observer = undefined;
		runtime.pending = [];
	};
	const deactivate = () => {
		runtime?.observer?.dispose();
		runtime?.ctx.ui.setStatus("watcher", undefined);
		runtime = undefined;
	};
	const activate = (ctx: ExtensionContext): WatcherRuntime => {
		if (runtime) {
			runtime.ctx = ctx;
			return runtime;
		}
		runtime = { ctx, pending: [], lastTurnIndex: 0, evaluating: false };
		ctx.ui.setStatus("watcher", ctx.ui.theme.fg("dim", `👓 ${formatModelName(config.model)}/${config.thinking}`));
		return runtime;
	};
	// 与指挥官事件同构：忙时卡片经 steer 队列句缝追加，歇透时走前门唤起（见 deliver.ts）。
	const speak = (active: WatcherRuntime, advice: Advice, turnIndex: number) => {
		const card: WatcherCard = { note: advice.note, turnIndex };
		return deliver(pi, active.ctx, { customType: WATCHER_MESSAGE_TYPE, content: adviceMessage(card), details: card });
	};
	const evaluate = async (active: WatcherRuntime) => {
		active.evaluating = true;
		let current = era;
		try {
			while (runtime === active && active.pending.length && !reviewActive) {
				current = era;
				// 合并跳最新：评估期间到达的回合并进下一批，不排队补评估。
				const increment = active.pending.splice(0).join("\n");
				const turnIndex = active.lastTurnIndex;
				active.observer ??= await spawnObserver({
					cwd: active.ctx.cwd,
					model: await (dependencies.resolveModel ?? resolveConfiguredModel)(config.model),
					thinking: config.thinking,
					pool,
				});
				const advice = await active.observer.evaluate(increment);
				if (current !== era) continue;
				if (advice && runtime === active) await speak(active, advice, turnIndex);
				// 自身上下文快满时也重新入场：观察员只需要当下，不需要完整历史。
				if ((active.observer?.contextPercent() ?? 0) >= CONTEXT_RESET_PERCENT) resetObserver();
			}
		} catch (error) {
			// 被重新入场中断的评估不算故障：下一批增量会开一个新观察会话。
			if (current === era) {
				active.ctx.ui.notify(`观察员已停止：${error instanceof Error ? error.message : String(error)}`, "warning");
				deactivate();
			}
		} finally {
			active.evaluating = false;
		}
	};

	pi.registerCommand("fire-watch", {
		description: "翻转当前会话的观察员开关",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("/fire-watch 不接受参数", "error");
				return;
			}
			if (runtime) {
				deactivate();
				ctx.ui.notify("观察员已关闭", "info");
				return;
			}
			activate(ctx);
			ctx.ui.notify("观察员已开启", "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		deactivate();
		if (!config.enabled) return;
		activate(ctx);
	});

	pi.on("turn_end", (event, ctx) => {
		const active = runtime;
		if (!active) return;
		active.ctx = ctx;
		active.pending.push(renderTurn(event, config.context));
		active.lastTurnIndex = event.turnIndex;
		if (!active.evaluating && !reviewActive) void evaluate(active);
	});

	// fire-review 活跃期静默：不与对抗审查的反馈打架，增量留着审查完合并评估。
	pi.events?.on?.(REVIEW_OCCUPANCY_CHANNEL, (data: { active?: boolean } | undefined) => {
		reviewActive = Boolean(data?.active);
		const active = runtime;
		if (reviewActive || !active || active.evaluating || !active.pending.length) return;
		void evaluate(active);
	});

	// 主会话压缩：旧增量已不再对应主会话现场，观察员从当前尾部重新入场而不回放。
	pi.on("session_compact", () => resetObserver());
	pi.on("session_shutdown", () => deactivate());
}

function loadWatcherConfiguration(): WatcherConfig | { error: string } {
	let loaded: ReturnType<typeof loadConfig>;
	try {
		loaded = loadConfig();
	} catch (error) {
		return { error: `观察员配置读取失败：${error instanceof Error ? error.message : String(error)}` };
	}
	// features 也算阻断集：开关写成字符串 "false" 时 `!== false` 仍会注册，
	// 而启用观察员意味着每个回合都对模型发起真实调用。
	const problems = loaded.problems.filter((problem) =>
		problem.startsWith("watcher") || problem.startsWith("未知字段 watcher.")
		|| problem.startsWith("config.jsonc") || problem.startsWith("features"));
	if (problems.length) return { error: `观察员配置有问题，已停止：${problems.join("；")}` };
	return loaded.config.watcher;
}

async function resolveConfiguredModel(id: string): Promise<Model<any>> {
	const runtime = await ModelRuntime.create({
		authPath: `${getAgentDir()}/auth.json`,
		modelsPath: `${getAgentDir()}/models.json`,
	});
	const slash = id.indexOf("/");
	const model = slash > 0 ? runtime.getModel(id.slice(0, slash), id.slice(slash + 1)) : undefined;
	// 扩展注册的 provider 在无扩展子会话里不可解析（实测），必须明确引导而不是静默失败。
	if (!model) throw new Error(`找不到模型：${id}；观察员只能使用内置 provider 的模型`);
	return model;
}
