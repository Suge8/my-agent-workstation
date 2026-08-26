/** 底部两行状态栏：位置/会话名 + 模型/额度/上下文/缓存/速度。 */
import { basename, join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { formatModelName } from "../format.js";
import { thinkingColor } from "../theme.js";
import { fileQuotaCache } from "./quota-cache.js";
import { registerQuota } from "./quota.js";
import type { QuotaStatus } from "./quota-parse.js";
import {
	alignRight,
	fitMetadataLine,
	fitStatusLine,
	reviewStatus,
	statusBadges,
	latestCacheHitPercent,
	renderCache,
	renderContext,
	renderLocation,
	renderQuota,
	renderTps,
} from "./render.js";
import { type TpsStatus, registerTps } from "./tps.js";

export function registerStatusBar(pi: ExtensionAPI, subsession = false): void {
	if (subsession) return;
	let quota: QuotaStatus | undefined;
	let tpsStatus: TpsStatus | undefined;
	let requestRender = () => {};

	registerQuota(
		pi,
		(status) => {
			quota = status;
			requestRender();
		},
		fileQuotaCache(join(getAgentDir(), "tmp")),
	);
	registerTps(pi, (status) => {
		tpsStatus = status;
		requestRender();
	});

	// 助手消息落定后缓存命中率才可算。
	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") requestRender();
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsubscribe = footerData.onBranchChange(requestRender);

			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					const statuses = footerData.getExtensionStatuses();
					const review = reviewStatus(statuses);
					const model = ctx.model;
					const thinkingLevel = pi.getThinkingLevel();
					const modelCore = `${theme.fg("accent", `🧠 ${formatModelName(model?.id)}`)}${
						model?.reasoning
							? theme.fg(thinkingColor(thinkingLevel), `/${thinkingLevel}`)
							: ""
					}`;
					const modelText = statuses.has("pi-openai-native-fast")
						? `${modelCore}${theme.fg("warning", " · ⚡fast")}`
						: modelCore;

					const location = renderLocation(
						theme,
						basename(ctx.sessionManager.getCwd()) || "/",
						footerData.getGitBranch(),
					);
					const sessionName = ctx.sessionManager.getSessionName();
					const title = sessionName ? theme.fg("dim", `💬 ${sessionName}`) : "";

					const usage = ctx.getContextUsage();
					const percent = usage?.percent;
					const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? 0;
					const separator = ` ${theme.fg("dim", "｜")}`;

					const statusLine = fitStatusLine(
						{
							model: modelText,
							modelCompact: modelCore,
							quota: quota ? renderQuota(theme, quota) : "",
							quotaCompact: quota ? renderQuota(theme, quota, true) : "",
							context: renderContext(theme, percent, contextWindow),
							contextCompact: renderContext(theme, percent, contextWindow, true),
							cache: renderCache(
								theme,
								latestCacheHitPercent(ctx.sessionManager.getEntries()),
							),
							tps: renderTps(theme, tpsStatus),
						},
						width,
						separator,
					);
					return [
						alignRight(
							fitMetadataLine(location, title, width, separator, statusBadges(statuses, separator)),
							review,
							width,
						),
						statusLine,
					];
				},
			};
		});
	});

	pi.on("thinking_level_select", () => requestRender());
	pi.on("session_shutdown", (_event, ctx) => {
		requestRender = () => {};
		ctx.ui.setFooter(undefined);
	});
}
