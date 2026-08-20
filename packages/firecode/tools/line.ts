/** 单条工具行的渲染：状态字形 + 标签 + 主体 + 右侧耗时/大小，展开时附完整结果。 */
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type ClipSide, clip, oneLine } from "../format.js";
import {
	type Part,
	clipParts,
	durationPart,
	paint,
	partsWidth,
	sizePart,
} from "./parts.js";
import { takeDuration } from "./timing.js";

const RAIL = "▏ ";
/** 右侧列与主体之间至少留出的空隙，不够就先丢弃右侧列 */
const RIGHT_GAP = 2;
const MIN_VALUE_WIDTH = 8;
/** 有错误摘要时，主体最多占可用宽度的比例 */
const ERROR_VALUE_RATIO = 0.4;

const STATUS = {
	run: { glyph: "●", color: "accent", bg: "toolPendingBg" },
	ok: { glyph: "✓", color: "success", bg: "toolSuccessBg" },
	err: { glyph: "✗", color: "error", bg: "toolErrorBg" },
} as const;

/** renderCall / renderResult 之间共享的行状态。 */
export type RowState = {
	/** 结果字符数（read/bash），驱动右对齐大小列 */
	chars?: number;
	durationMs?: number;
	/** 结果产生的动态后缀（edit 的 ±diff） */
	meta?: Part[];
	/** 失败时的一行摘要 */
	errorText?: string;
};

export type RenderContext = {
	state: RowState;
	cwd: string;
	toolCallId: string;
	isPartial: boolean;
	isError: boolean;
	expanded: boolean;
};

type ResultContent = { type: string; text?: string };
export type ToolResult = { content?: ResultContent[]; details?: unknown };

export type ToolLineOptions = {
	label: string;
	value: Part[];
	/** 溢出时从哪端截断：路径保尾部，命令保头部 */
	clip: ClipSide;
	/** 紧跟 value 的左侧后缀（edit ±diff、write +N） */
	meta?: Part[];
	theme: Theme;
	ctx: RenderContext;
};

function sanitizeDisplayText(text: string): string {
	let output = "";
	for (const char of stripVTControlCharacters(text)) {
		const code = char.codePointAt(0);
		if (code === undefined || code === 0x0d) continue;
		if (code === 0x09 || code === 0x0a) output += char;
		else if (code > 0x1f && (code < 0xfff9 || code > 0xfffb)) output += char;
	}
	return output;
}

function resultText(result: ToolResult): { displayText: string; chars: number } {
	const blocks: string[] = [];
	let chars = 0;
	for (const item of result.content ?? []) {
		if (item.type !== "text" || typeof item.text !== "string") continue;
		blocks.push(sanitizeDisplayText(item.text));
		chars += item.text.length;
	}
	return { displayText: blocks.join("\n"), chars };
}

/** 右侧列之间用 " · " 分隔。 */
function rightContentWidth(parts: Part[]): number {
	return partsWidth(parts) + Math.max(0, parts.length - 1) * 3;
}

const EMPTY_RESULT: Component = { render: () => [], invalidate() {} };

class ExpandedResult implements Component {
	constructor(
		private readonly text: string,
		private readonly theme: Theme,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const lines = wrapTextWithAnsi(this.text, Math.max(1, width));
		return ["", ...lines.map((line) => this.theme.fg("toolOutput", line))];
	}
}

function applyBg(line: string, width: number, bgFn?: (text: string) => string): string {
	const visLen = visibleWidth(line);
	const padNeeded = Math.max(0, width - visLen);
	const padded = line + " ".repeat(padNeeded);
	return bgFn ? bgFn(padded) : padded;
}

export class ToolLine implements Component {
	constructor(private readonly options: ToolLineOptions) {}

	invalidate(): void {}

	render(width: number): string[] {
		const { theme, ctx } = this.options;
		const state = ctx.state;
		const status = ctx.isError ? STATUS.err : ctx.isPartial ? STATUS.run : STATUS.ok;
		const safeWidth = Math.max(1, width - 2);
		const head: Part[] = [
			{ text: RAIL, color: "dim" },
			{ text: `${status.glyph} `, color: status.color, bold: true },
			{
				text: `${this.options.label} `,
				color: ctx.isError ? "error" : "toolTitle",
				bold: true,
			},
		];
		const headWidth = partsWidth(head);
		const bgFn = typeof theme.bg === "function" ? (text: string) => theme.bg(status.bg, text) : undefined;
		if (safeWidth <= headWidth) {
			const clipped = paint(theme, clipParts(head, safeWidth, "end"));
			return [applyBg(clipped, width, bgFn)];
		}

		const meta = [...(this.options.meta ?? []), ...(state.meta ?? [])];
		const right = [durationPart(state.durationMs), sizePart(state.chars)].filter(
			(part): part is Part => !!part,
		);
		while (
			right.length &&
			safeWidth - headWidth - rightContentWidth(right) - RIGHT_GAP < MIN_VALUE_WIDTH
		)
			right.pop();
		const rightVisible = rightContentWidth(right);
		const freeWidth = safeWidth - headWidth - (right.length ? rightVisible + RIGHT_GAP : 0);
		const errorText = ctx.isError && !ctx.expanded ? oneLine(state.errorText ?? "") : "";
		let value = [...this.options.value, ...meta];
		if (ctx.isError) value = value.map((part) => ({ ...part, color: "error" as const }));

		let errorPart: Part | undefined;
		if (errorText) {
			value = clipParts(value, Math.max(1, Math.floor(freeWidth * ERROR_VALUE_RATIO)), this.options.clip);
			const errorWidth = freeWidth - partsWidth(value) - 3;
			if (errorWidth >= 1)
				errorPart = { text: ` · ${clip(errorText, errorWidth, "end")}`, color: "error" };
		} else {
			value = clipParts(value, freeWidth, this.options.clip);
		}

		const body = [...head, ...value, ...(errorPart ? [errorPart] : [])];
		let line = paint(theme, body);
		if (right.length) {
			const pad = Math.max(RIGHT_GAP, safeWidth - partsWidth(body) - rightVisible);
			line +=
				" ".repeat(pad) +
				right.map((part) => paint(theme, [part])).join(theme.fg("dim", " · "));
		}
		return [applyBg(line, width, bgFn)];
	}
}

/** 折叠时只回写行状态；展开时输出完整结果。 */
export function makeResultRenderer(sized: boolean) {
	return (
		result: ToolResult,
		options: { expanded: boolean },
		theme: Theme,
		context: RenderContext,
	): Component => {
		const state = context.state;
		const { displayText, chars } = resultText(result);
		if (sized) state.chars = chars;
		const durationMs = takeDuration(context.toolCallId);
		if (durationMs !== undefined) state.durationMs = durationMs;
		state.errorText = context.isError ? displayText : "";
		return options.expanded && displayText !== ""
			? new ExpandedResult(displayText, theme)
			: EMPTY_RESULT;
	};
}
