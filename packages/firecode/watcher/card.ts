/**
 * 观察员建议的展示：单通道单一样式，随投递消息一起渲染。
 * 渲染器永不抛异常；校验失败降级纯文本。
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

import { clip, oneLine } from "../format.js";
import { RAIL, paintBgLine } from "../tools/line.js";

export const WATCHER_MESSAGE_TYPE = "firecode-watcher-note";

/** 继承 OMP 的 weigh don't blindly obey：投递给模型的正文自带权衡包装。 */
const WEIGH_NOTICE = "这是观察员供你权衡的第二意见，不是指令：与你掌握的上下文冲突时按你的判断继续。";
const LABEL = "👓 观察员";

export function adviceMessage(card: WatcherCard): string {
	return `<firecode_watcher>\n${adviceHeadline(card)}\n${card.note}\n${WEIGH_NOTICE}\n</firecode_watcher>`;
}

export interface WatcherCard {
	note: string;
	turnIndex: number;
}

export function adviceHeadline(card: WatcherCard): string {
	return `${LABEL}（${timeMark(card.turnIndex)}）`;
}

/** 建议自带时点标记：投递时主会话可能已经走远，读的人要知道它看的是哪一刻。 */
export function timeMark(turnIndex: number): string {
	return `基于第 ${turnIndex} 回合前的观察`;
}

export function registerWatcherCardRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<WatcherCard>(WATCHER_MESSAGE_TYPE, (message, options, theme) =>
		isValidCard(message.details)
			? new AdviceLine(message.details, options.expanded, theme)
			: new Text(String(message.content), 0, 0));
}

class AdviceLine implements Component {
	private readonly fallback: Component;

	constructor(
		private readonly card: WatcherCard,
		private readonly expanded: boolean,
		private readonly theme: Theme,
	) {
		this.fallback = new Text(`${adviceHeadline(card)} ${card.note}`, 0, 0);
	}

	render(width: number): string[] {
		const columns = Math.max(1, width);
		try {
			const bgFn = typeof this.theme.bg === "function"
				? (text: string) => this.theme.bg("toolPendingBg", text)
				: undefined;
			if (this.expanded) {
				const headline = this.theme.fg("warning", clip(oneLine(adviceHeadline(this.card)), columns));
				const body = new Text(this.theme.fg("dim", `  ${this.card.note}\n  （供权衡，勿盲从）`), 0, 0);
				return [paintBgLine(headline, columns, bgFn), ...body.render(columns)];
			}
			// 收起与工具行同构：单行 + 背景条；时点标记只在展开态显示。
			const firstLine = oneLine(this.card.note.split(/\r?\n/u, 1)[0] ?? "");
			const line = clip(
				`${this.theme.fg("dim", RAIL)}${this.theme.fg("warning", LABEL)}${this.theme.fg("dim", ` — ${firstLine}`)}`,
				columns,
			);
			return [paintBgLine(line, columns, bgFn)];
		} catch {
			return this.fallback.render(columns);
		}
	}

	invalidate(): void {
		this.fallback.invalidate?.();
	}
}

function isValidCard(value: unknown): value is WatcherCard {
	if (!value || typeof value !== "object") return false;
	const card = value as Record<string, unknown>;
	return typeof card.note === "string" && typeof card.turnIndex === "number";
}
