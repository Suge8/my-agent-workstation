/**
 * 把 pi 的会话身份投影到 herdr agent 副标题：`pi·模型/思考等级` + 会话名。
 * 会话名同时以 `session` 自定义 token 上报，供 herdr 侧边栏 `$session` 行布局显示；
 * 只写带 source 的 pane 显示元数据，不碰持久 pane/tab 名；失败静默，不影响会话。
 * herdr 之外、非 TUI 模式或 Master Worker 内自我禁用。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatModelName } from "../format.js";
import { herdrPaneEnv, herdrRequest } from "../herdr-client.js";

const SOURCE = "firecode";

/** herdr 按 seq 丢弃过期上报，同一 pane 的元数据必须单调递增。 */
let seq = Date.now() * 1000;
const nextSeq = () => (seq += 1);

type Identity = { title: string; agent: string };

export function projectIdentity(
	sessionName: string | undefined,
	modelId: string | undefined,
	thinking: string | undefined,
): Identity {
	const level = thinking && thinking !== "off" ? `/${thinking}` : "";
	return {
		title: sessionName ?? "",
		agent: `pi·${formatModelName(modelId)}${level}`,
	};
}

export function registerHerdrDisplay(pi: ExtensionAPI): void {
	const env = herdrPaneEnv();
	if (!env) return;
	if (process.env.FIRECODE_MASTER_WORKER) return;
	const paneId = env.paneId;

	let chain = Promise.resolve();
	let published: string | undefined;
	/** 链尾意图：最近一次入队的身份。去重必须以它为准——拿已确认身份提前返回
	 * 会让 A→B→A 快速切回把过时的 B 留在 pane 上；同时它挡住同身份密集事件的重发。
	 * 失败且仍是链尾时清空，保持「失败静默并由下一事件重试」的既有语义。 */
	let enqueued: string | undefined;

	const publish = (identity: Identity): Promise<void> => {
		const key = `${identity.title}\u0000${identity.agent}`;
		if (key === (enqueued ?? published)) return chain;
		enqueued = key;
		chain = chain.then(async () => {
			const delivered = await herdrRequest(SOURCE, "pane.report_metadata", {
				pane_id: paneId,
				source: SOURCE,
				display_agent: identity.agent || null,
				clear_display_agent: !identity.agent,
				title: identity.title || null,
				clear_title: !identity.title,
				// 侧边栏行布局只能消费自定义 token（title 不在 token 集里）；null 即清除。
				tokens: { session: identity.title || null },
				seq: nextSeq(),
			});
			published = delivered ? key : undefined;
			if (!delivered && enqueued === key) enqueued = undefined;
		});
		return chain;
	};

	const sync = (ctx: ExtensionContext): Promise<void> =>
		ctx.mode === "tui"
			? publish(
					projectIdentity(
						ctx.sessionManager.getSessionName(),
						ctx.model?.id,
						ctx.model?.reasoning ? pi.getThinkingLevel() : undefined,
					),
				)
			: Promise.resolve();

	pi.on("session_start", (_event, ctx) => sync(ctx));
	// 覆盖 /rename、快捷键与 pi 自动命名：宿主已把改名收口到这一个事件。
	pi.on("session_info_changed", (_event, ctx) => sync(ctx));
	pi.on("model_select", (_event, ctx) => sync(ctx));
	pi.on("thinking_level_select", (_event, ctx) => sync(ctx));
	// quit 后 pane 退回 shell；其它 session 切换会立刻由新 session_start 覆盖。
	pi.on("session_shutdown", (event, ctx) =>
		event.reason === "quit" && ctx.mode === "tui"
			? publish({ title: "", agent: "" })
			: undefined,
	);
}
