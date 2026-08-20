/**
 * 火焰 working 效果：工作回合期间编辑器上方居中燃烧的多行火焰 widget。
 *
 * 走 setWidget(aboveEditor)：多行组件的合法槽位（审查活动框同款），由 TUI
 * 排版器独立渲染，与工具输出物理隔离——旧 working-style.ts 的事故是把多行帧
 * 塞进单行 spinner 通道，这里结构上不可能复发。agent_start 挂载、agent_end 撤下，
 * 动画计时器随组件 dispose 清理。高度随终端行数自适应，宽度不够时逐级缩小。
 *
 * 火焰即工作信号：回合或审查占用期隐藏宿主的 「Working...」 文本行。
 * review 模块也写 setWorkingVisible，且它的写入在同一同步调度链里排在占用事件之后；
 * 因此本模块的所有 UI 写入经微任务合并调度，在调度链收尾后作为最终仲裁者落地，
 * 消除「占用期 agent_end 无条件复显 Working 行」一类最后写者竞态。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { FLAME_FRAME_COUNT, flameFrameLines, flameFrameWidth } from "../flame-frames.js";

const WIDGET_KEY = "firecode-working-flame";
const FRAME_MS = 100;
const MAX_HEIGHT = 10;
const MIN_HEIGHT = 3;

/** 高度自适应：约占终端四分之一，钳在 3–10 行；行数未知时给满高。 */
export function flameHeightFor(terminalRows: number | undefined): number {
	if (!terminalRows || !Number.isFinite(terminalRows)) return MAX_HEIGHT;
	return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.floor(terminalRows / 4)));
}

/** 宽度自适应：装不下就逐级降高（火焰宽随高缩），实在不行才隐藏。 */
export function flameFitHeight(height: number, width: number): number {
	for (let fit = height; fit >= MIN_HEIGHT; fit -= 1) {
		if (flameFrameWidth(fit) <= width) return fit;
	}
	return 0;
}

export function registerWorkingFlame(pi: ExtensionAPI): void {
	let turnActive = false;
	let reviewHeld = false;
	let ui: ExtensionContext["ui"] | undefined;
	let pending = false;

	const apply = () => {
		pending = false;
		if (!ui) return;
		// Working 行：回合内由大火焰替代，审查占用期由审查活动条替代，两者都不在才复显。
		if (typeof ui.setWorkingVisible === "function")
			ui.setWorkingVisible(!turnActive && !reviewHeld);
		if (typeof ui.setWidget !== "function") return;
		if (turnActive && !reviewHeld)
			ui.setWidget(
				WIDGET_KEY,
				(tui: TUI) => new WorkingFlame(tui, () => tui.requestRender()),
				{ placement: "aboveEditor" },
			);
		else ui.setWidget(WIDGET_KEY, undefined);
	};
	/** 微任务合并：同一调度链内的多个事件只落地一次，且排在 review 的同步写入之后。 */
	const sync = () => {
		if (pending) return;
		pending = true;
		queueMicrotask(apply);
	};

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ui = ctx.ui;
		turnActive = true;
		sync();
	});
	pi.on("agent_end", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ui = ctx.ui;
		turnActive = false;
		sync();
	});
	// 审查占用频道（review 模块发布）：审查活跃期活动条自带火焰，大火焰退让避免双火同烧。
	pi.events?.on?.("herdr:blocked", (data: { active?: boolean } | undefined) => {
		reviewHeld = Boolean(data?.active);
		sync();
	});
}

/** 居中的多行火焰；素材自带 ANSI 颜色与行尾复位。 */
class WorkingFlame implements Component {
	private frame = 0;
	private readonly timer: ReturnType<typeof setInterval>;

	constructor(
		private readonly tui: TUI,
		requestRender: () => void,
	) {
		this.timer = setInterval(() => {
			this.frame += 1;
			requestRender();
		}, FRAME_MS);
		this.timer.unref?.();
	}

	render(width: number): string[] {
		const rows = (this.tui as TUI & { terminal?: { rows?: number } }).terminal?.rows;
		const height = flameFitHeight(flameHeightFor(rows), Math.max(0, width));
		if (height === 0) return [];
		const flameWidth = flameFrameWidth(height);
		const indent = " ".repeat(Math.max(0, Math.floor((width - flameWidth) / 2)));
		return flameFrameLines(height, this.frame % FLAME_FRAME_COUNT).map(
			(line) => `${indent}${line}`,
		);
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.timer);
	}
}
