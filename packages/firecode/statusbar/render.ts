/** 状态栏的纯渲染与布局：给定数据和宽度产出字符串，不触碰会话状态。 */
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { clip, formatDuration, formatTokens, oneLine } from "../format.js";
import { cacheColor, contextColor, quotaColor } from "../theme.js";
import type { QuotaStatus } from "./quota-parse.js";
import type { TpsStatus } from "./tps.js";

export type StatusLineParts = {
	model: string;
	modelCompact: string;
	quota: string;
	quotaCompact: string;
	context: string;
	contextCompact: string;
	cache: string;
	tps: string;
};

type ForegroundTheme = {
	fg(color: ThemeColor, text: string): string;
};

/** 最近一条助手消息的 cacheRead / (input + cacheRead + cacheWrite)。 */
export function latestCacheHitPercent(
	entries: ReadonlyArray<{
		type?: string;
		message?: {
			role?: string;
			usage?: { input?: number; cacheRead?: number; cacheWrite?: number };
		};
	}>,
): number | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		const usage = entry.message.usage;
		if (!usage) continue;
		const input = usage.input ?? 0;
		const cacheRead = usage.cacheRead ?? 0;
		const cacheWrite = usage.cacheWrite ?? 0;
		const promptTokens = input + cacheRead + cacheWrite;
		if (promptTokens <= 0 || (cacheRead === 0 && cacheWrite === 0)) return undefined;
		return (cacheRead / promptTokens) * 100;
	}
	return undefined;
}

export function renderLocation(
	theme: ForegroundTheme,
	directory: string,
	branch: string | null | undefined,
): string {
	return [theme.fg("dim", `📍${directory}`), branch ? theme.fg("dim", `🌿 ${branch}`) : ""]
		.filter(Boolean)
		.join(" · ");
}

export function renderQuota(
	theme: ForegroundTheme,
	status: QuotaStatus,
	compact = false,
): string {
	if (status.state === "loading") return theme.fg("dim", "🔋 …");
	if (status.state === "unavailable") return theme.fg("dim", "🔋 —");
	const windows = compact
		? [
				status.windows.reduce((tightest, window) =>
					window.remaining < tightest.remaining ? window : tightest,
				),
			]
		: status.windows;
	return `${theme.fg("dim", "🔋 ")}${windows
		.map((window) =>
			theme.fg(quotaColor(window.remaining), `${window.label} ${window.remaining}%`),
		)
		.join(theme.fg("dim", "/"))}`;
}

export function renderContext(
	theme: ForegroundTheme,
	percent: number | null | undefined,
	contextWindow: number,
	compact = false,
): string {
	const percentText = percent == null ? "?" : `${percent.toFixed(1)}%`;
	return `${theme.fg("dim", "📦 ")}${theme.fg(contextColor(percent), percentText)}${
		compact ? "" : theme.fg("dim", `/${formatTokens(contextWindow)}`)
	}`;
}

export function renderCache(theme: ForegroundTheme, percent: number | undefined): string {
	if (percent === undefined) return "";
	return `${theme.fg("dim", "♻️ ")}${theme.fg(cacheColor(percent), `${Math.round(percent)}%`)}`;
}

export function renderTps(theme: ForegroundTheme, status: TpsStatus | undefined): string {
	if (!status) return "";
	if (status.phase === "live") {
		return theme.fg(
			"success",
			`↗ ${status.tokensPerSecond ? `${status.tokensPerSecond}t/s` : "…"}`,
		);
	}
	const elapsed = formatDuration(status.elapsedSeconds * 1_000);
	const duration = theme.fg("dim", `⏱ ${elapsed}${status.tokensPerSecond ? " · " : ""}`);
	return status.tokensPerSecond
		? `${duration}${theme.fg("success", `↗ ${status.tokensPerSecond}t/s`)}`
		: duration;
}

/** /fire-review 广播的审查进度，右对齐挂在首行末尾。 */
export function reviewStatus(statuses: ReadonlyMap<string, string>): string {
	return oneLine(statuses.get("fire-review") ?? "");
}

/** 首行模块状态由各模块的 setStatus/onChange 驱动，状态栏只负责组合。 */
export function statusBadges(statuses: ReadonlyMap<string, string>, separator: string): string {
	return [statuses.get("master"), statuses.get("watcher")].filter(Boolean).join(separator);
}

export function alignRight(left: string, right: string, width: number): string {
	if (!right) return left;
	const padding = width - visibleWidth(left) - visibleWidth(right);
	return padding >= 2 ? `${left}${" ".repeat(padding)}${right}` : left;
}

export function fitMetadataLine(
	location: string,
	title: string,
	width: number,
	separator: string,
	badge = "",
): string {
	if (width <= 0) return "";
	// badge（如指挥官态）整段取舍：放不下就丢，不截半个，再走会话名截断阶梯。
	if (badge) {
		const full = [location, title, badge].filter(Boolean).join(separator);
		if (visibleWidth(full) <= width) return full;
	}
	if (!title) return clip(location, width, "end", visibleWidth(location) > width ? "…" : "");
	const full = `${location}${separator}${title}`;
	if (visibleWidth(full) <= width) return full;
	const titleWidth = width - visibleWidth(location) - visibleWidth(separator);
	if (titleWidth > 0) {
		const fittedTitle = clip(title, titleWidth, "end");
		if (fittedTitle) return `${location}${separator}${fittedTitle}`;
	}
	return clip(location, width, "end");
}

const joinParts = (parts: string[], separator: string) => parts.filter(Boolean).join(separator);

export function fitStatusLine(
	parts: StatusLineParts,
	width: number,
	separator: string,
): string {
	if (width <= 0) return "";
	// joinParts 会丢掉空的 quota/cache/tps。顺序：model → quota? → context → cache → tps。
	const candidates = [
		[parts.model, parts.quota, parts.context, parts.cache, parts.tps],
		[parts.model, parts.quota, parts.context, parts.cache],
		[parts.modelCompact, parts.quota, parts.context, parts.cache],
		[parts.modelCompact, parts.quotaCompact, parts.context, parts.cache],
		[parts.modelCompact, parts.context, parts.cache],
		[parts.modelCompact, parts.context],
		[parts.modelCompact, parts.contextCompact],
	].map((candidate) => joinParts(candidate, separator));
	for (const candidate of candidates) {
		if (visibleWidth(candidate) <= width) return candidate;
	}

	const context = parts.contextCompact || parts.context;
	const contextWidth = visibleWidth(context);
	const modelBudget = width - contextWidth - visibleWidth(separator);
	if (modelBudget > 0 && contextWidth <= width) {
		return `${clip(parts.modelCompact, modelBudget, "end")}${separator}${context}`;
	}
	return clip(context, width, "end", "");
}
