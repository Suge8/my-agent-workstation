/** 宽度、文本与数值格式化：状态栏与工具行共用。 */
import { visibleWidth } from "@earendil-works/pi-tui";

const ELLIPSIS = "…";
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 压平换行与连续空白，用于把任意文本塞进单行 UI。 */
export function oneLine(value = ""): string {
	return value
		.replace(/[\r\n\t]+/g, " ")
		.replace(/ {2,}/g, " ")
		.trim();
}

export type ClipSide = "start" | "end";

/**
 * 按显示宽度截断，保留完整字素簇。
 * `from: "end"` 保留头部（命令），`from: "start"` 保留尾部（路径 basename）。
 */
export function clip(
	text: string,
	width: number,
	from: ClipSide = "end",
	ellipsis: string = ELLIPSIS,
): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	const target = Math.max(0, width - visibleWidth(ellipsis));
	const segments = [...segmenter.segment(text)].map((entry) => entry.segment);
	let output = "";
	let used = 0;
	if (from === "start") {
		for (let index = segments.length - 1; index >= 0; index--) {
			const segmentWidth = visibleWidth(segments[index]);
			if (used + segmentWidth > target) break;
			output = segments[index] + output;
			used += segmentWidth;
		}
		return ellipsis + output;
	}
	for (const segment of segments) {
		const segmentWidth = visibleWidth(segment);
		if (used + segmentWidth > target) break;
		output += segment;
		used += segmentWidth;
	}
	return output + ellipsis;
}

/** 1234 → 1.2k，1_500_000 → 1.5M；0 与 undefined 显示为 ?。 */
export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) {
		const value = tokens / 1_000_000;
		return value >= 10 ? `${Math.round(value)}M` : `${value.toFixed(1)}M`;
	}
	if (tokens >= 1_000) {
		const value = tokens / 1_000;
		return value >= 10 ? `${Math.round(value)}k` : `${value.toFixed(1)}k`;
	}
	return tokens ? `${tokens}` : "?";
}

/** 900 → 0.9s，12_400 → 12s，93_000 → 1m33s。 */
export function formatDuration(milliseconds: number): string {
	if (milliseconds < 10_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
	const totalSeconds = Math.round(milliseconds / 1_000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
}

/** 去掉模型 id 的 provider 前缀与日期后缀。 */
export function formatModelName(id: string | undefined): string {
	if (!id) return "no-model";
	return (id.split("/").pop() ?? id)
		.replace(/-\d{8}$/, "")
		.replace(/-\d{4}-\d{2}-\d{2}$/, "");
}
