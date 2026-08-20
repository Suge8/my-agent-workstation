/** 工具行的着色片段：路径、命令、大小、耗时、diff 统计。 */
import { homedir } from "node:os";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type ClipSide, clip, formatDuration, oneLine } from "../format.js";
import { sizeColor } from "../theme.js";

/** pi 公共出口未导出 ThemeBg：从 Theme.bg 的参数派生，避免依赖内部路径。 */
type ThemeBg = Parameters<Theme["bg"]>[0];

const HOME = homedir();
const ELLIPSIS = "…";
/** 结果小于此字符数不显示大小列（噪音阈值） */
const SIZE_MIN_CHARS = 100;
/** 快过此耗时不值得占一列 */
const DURATION_MIN_MS = 1_000;

/** 一段带颜色的文本片段；不给 color 则用终端默认前景色。 */
export type Part = { text: string; color?: ThemeColor; bg?: ThemeBg; bold?: boolean };

export function partsWidth(parts: Part[]): number {
	return parts.reduce((total, part) => total + visibleWidth(part.text), 0);
}

export function paint(theme: Theme, parts: Part[]): string {
	return parts
		.map((part) => {
			let text = part.bold ? theme.bold(part.text) : part.text;
			if (part.color && typeof theme.fg === "function") text = theme.fg(part.color, text);
			if (part.bg && typeof theme.bg === "function") text = theme.bg(part.bg, text);
			return text;
		})
		.join("");
}

/** 按方向截断片段序列：start 保留尾部片段（basename 优先），end 保留头部。 */
export function clipParts(parts: Part[], width: number, from: ClipSide): Part[] {
	if (partsWidth(parts) <= width) return parts;
	const ordered = from === "start" ? [...parts].reverse() : parts;
	const kept: Part[] = [];
	let used = 0;
	for (const part of ordered) {
		const partWidth = visibleWidth(part.text);
		if (used + partWidth <= width) {
			kept.push(part);
			used += partWidth;
			continue;
		}
		const room = width - used;
		if (room >= 1) kept.push({ ...part, text: clip(part.text, room, from) });
		break;
	}
	return from === "start" ? kept.reverse() : kept;
}

/** 路径显示：cwd 内 → ./，家目录 → ~，目录前缀暗色、basename 亮色。 */
export function pathValue(path: string, cwd: string, suffix = ""): Part[] {
	let display = path || ELLIPSIS;
	if (cwd && display.startsWith(`${cwd}/`)) display = `./${display.slice(cwd.length + 1)}`;
	else if (HOME && display.startsWith(HOME)) display = `~${display.slice(HOME.length)}`;
	const cut = display.lastIndexOf("/") + 1;
	const parts: Part[] = [];
	if (cut > 0) parts.push({ text: display.slice(0, cut), color: "muted" });
	parts.push({ text: display.slice(cut), color: "accent" });
	if (suffix) parts.push({ text: suffix, color: "muted" });
	return parts;
}

const CONNECTOR = /^(&&|\|\||\||;|↵)$/;
const REDIRECT = /^\d*(>>?|<)/;
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

function appendPart(parts: Part[], text: string, color?: ThemeColor): void {
	const last = parts[parts.length - 1];
	if (last && last.color === color) last.text += text;
	else parts.push({ text, color });
}

/** 命令分层着色：命令词 accent，参数默认色，管道/重定向/连接符/环境赋值暗色。 */
export function commandParts(command: string): Part[] {
	const display = oneLine((command || "").replace(/\r?\n/g, " ↵ ")).replaceAll(HOME, "~");
	if (!display) return [{ text: "$ ", color: "muted" }, { text: ELLIPSIS, color: "accent" }];
	const parts: Part[] = [{ text: "$ ", color: "muted" }];
	let expectCommand = true;
	for (const token of display.split(" ")) {
		let color: ThemeColor | undefined;
		if (CONNECTOR.test(token)) {
			color = "muted";
			expectCommand = true;
		} else if (REDIRECT.test(token)) {
			color = "muted";
		} else if (expectCommand && ENV_ASSIGN.test(token)) {
			color = "muted";
		} else if (expectCommand) {
			color = "accent";
			expectCommand = false;
		}
		if (token.endsWith(";")) expectCommand = true;
		appendPart(parts, `${token} `, color);
	}
	const last = parts[parts.length - 1];
	last.text = last.text.trimEnd();
	return parts;
}

export function sizePart(chars: number | undefined): Part | undefined {
	if (chars === undefined || chars < SIZE_MIN_CHARS) return undefined;
	return { text: `${(chars / 1000).toFixed(1)}k`, color: sizeColor(chars) };
}

export function durationPart(durationMs: number | undefined): Part | undefined {
	if (durationMs === undefined || durationMs < DURATION_MIN_MS) return undefined;
	return { text: formatDuration(durationMs), color: "dim" };
}

export function diffMeta(diff: string): Part[] {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	const parts: Part[] = [];
	if (added) parts.push({ text: ` +${added}`, color: "toolDiffAdded" });
	if (removed) parts.push({ text: ` -${removed}`, color: "toolDiffRemoved" });
	return parts;
}

export function genericArgsParts(args: unknown): Part[] {
	if (!args || typeof args !== "object") {
		return [{ text: String(args ?? ""), color: "accent" }];
	}
	const entries = Object.entries(args as Record<string, unknown>);
	if (entries.length === 0) return [];
	const preferredKey = ["prompt", "task", "query", "path", "command", "name", "message", "url"]
		.find((k) => k in (args as object));
	const [key, value] = preferredKey
		? [preferredKey, (args as Record<string, unknown>)[preferredKey]]
		: entries[0];
	const valStr = typeof value === "string" ? value : JSON.stringify(value);
	const text = oneLine(valStr.length > 60 ? `${valStr.slice(0, 57)}…` : valStr);
	return [{ text: `${key}: `, color: "muted" }, { text, color: "accent" }];
}
