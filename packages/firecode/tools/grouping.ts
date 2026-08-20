/**
 * 连续工具行的视觉合并与第三方工具通用单行兜底：
 * 1. 原生内置或声明了 self 的工具：保留自渲染，去除相邻空行形成轨道；
 * 2. 未知第三方或默认宽框工具：自动收口为通用 ToolLine 单行紧凑轨道与全宽背景。
 */
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { ToolLine } from "./line.js";
import { genericArgsParts } from "./parts.js";

const GROUP_PATCH = Symbol.for("pi.firecode.group-patch");
const REQUEST_RENDER_PATCH = Symbol.for("pi.firecode.request-render-patch");
const GLOBAL_STATE = Symbol.for("pi.firecode.tools-state");
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

function getTheme(): Theme {
	const globalTheme = (globalThis as any)[THEME_KEY];
	if (globalTheme && typeof globalTheme.fg === "function") return globalTheme;
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;
}

type RenderFunction = (width: number) => string[];
type RequestRenderFunction = (force?: boolean) => unknown;
type ToolRow = { toolName: unknown; setExpanded: unknown; render: RenderFunction };
type ToolRowPatch = { original: RenderFunction; patched: RenderFunction };
type ToolRowPrototype = ToolRow & { [GROUP_PATCH]?: ToolRowPatch };
type RequestRenderPatch = { original: RequestRenderFunction; patched: RequestRenderFunction };
type ContainerLike = { children: unknown[] };
type TuiLike = {
	requestRender: RequestRenderFunction;
	children?: unknown[];
	[REQUEST_RENDER_PATCH]?: RequestRenderPatch;
};
type GlobalState = {
	tui?: TuiLike;
	chat?: ContainerLike;
	indexedChildren?: unknown[];
	indexedLength?: number;
	joinedRows?: WeakSet<object>;
	patchedPrototype?: ToolRowPrototype;
	patchErrorReported?: boolean;
	decorated: Set<string>;
};

// 扩展热重载会重新执行模块，patch 状态必须挂在全局才能正确卸载。
const runtimeGlobal = globalThis as typeof globalThis & { [GLOBAL_STATE]?: GlobalState };
const globalState = (runtimeGlobal[GLOBAL_STATE] ??= { decorated: new Set<string>() });

function isToolRow(value: unknown): value is ToolRow {
	if (!value || typeof value !== "object") return false;
	const row = value as ToolRow;
	return typeof row.render === "function" && typeof row.setExpanded === "function" && "toolName" in row;
}

function isDecoratedToolRow(value: unknown): value is ToolRow {
	return isToolRow(value);
}

export function renderFallbackToolRow(row: any, width: number, customTheme?: Theme): string[] {
	const isError = row.result?.isError ?? false;
	const isPartial = row.isPartial ?? false;
	const toolName = typeof row.toolName === "string" ? row.toolName : "tool";
	const activeTheme = customTheme ?? getTheme();
	const toolLine = new ToolLine({
		label: toolName,
		value: genericArgsParts(row.args),
		clip: "end",
		theme: activeTheme,
		ctx: {
			state: row.rendererState ?? {},
			cwd: row.cwd ?? process.cwd(),
			toolCallId: row.toolCallId ?? "",
			isPartial,
			isError,
			expanded: row.expanded ?? false,
		},
	});
	const lines = ["", ...toolLine.render(width)];
	if (row.expanded && row.result) {
		const textContent = Array.isArray(row.result.content)
			? row.result.content
					.map((c: any) => (c?.type === "text" && typeof c.text === "string" ? c.text : ""))
					.filter(Boolean)
					.join("\n")
			: "";
		if (textContent) {
			const outputLines = textContent.split("\n").map((l: string) => activeTheme.fg("toolOutput", l));
			lines.push("", ...outputLines);
		}
	}
	return lines;
}

function findChatContainer(value: unknown, seen = new Set<unknown>()): ContainerLike | undefined {
	if (!value || typeof value !== "object" || seen.has(value)) return undefined;
	seen.add(value);
	const children = (value as ContainerLike).children;
	if (!Array.isArray(children)) return undefined;
	if (children.some(isToolRow)) return value as ContainerLike;
	for (const child of children) {
		const found = findChatContainer(child, seen);
		if (found) return found;
	}
	return undefined;
}

/** 增量标记"紧跟另一条装饰行"的行，聊天记录只增不改，可以从上次位置续算。 */
function indexJoinedRows(children: unknown[]): void {
	const canAppend =
		globalState.indexedChildren === children &&
		globalState.indexedLength !== undefined &&
		globalState.indexedLength <= children.length &&
		globalState.joinedRows !== undefined;
	const joinedRows =
		canAppend && globalState.joinedRows ? globalState.joinedRows : new WeakSet<object>();
	const start = canAppend ? Math.max(1, globalState.indexedLength ?? 1) : 1;
	for (let index = start; index < children.length; index++) {
		const current = children[index];
		if (isDecoratedToolRow(current) && isDecoratedToolRow(children[index - 1]))
			joinedRows.add(current);
	}
	globalState.indexedChildren = children;
	globalState.indexedLength = children.length;
	globalState.joinedRows = joinedRows;
}

function followsToolRow(row: ToolRow): boolean {
	if (!globalState.chat) globalState.chat = findChatContainer(globalState.tui);
	const children = globalState.chat?.children;
	if (!children) return false;
	if (globalState.indexedChildren !== children || globalState.indexedLength !== children.length)
		indexJoinedRows(children);
	return globalState.joinedRows?.has(row) ?? false;
}

/** 走 pi 原生渲染（会消费工具自带 renderCall）的工具；其余走通用兜底行。
 * subagents 自带中文 ToolLine 渲染（master/index.ts），不列入会被兜底行遮掉。 */
export const FIRECODE_TOOLS = new Set(["read", "bash", "edit", "write", "find", "grep", "ls", "subagents"]);

function patchToolRows(): void {
	if (globalState.patchedPrototype) return;
	const chat = globalState.chat ?? findChatContainer(globalState.tui);
	if (!chat) return;
	globalState.chat = chat;
	const row = chat.children.find(isToolRow);
	if (!row) return;
	const prototype = Object.getPrototypeOf(row) as ToolRowPrototype;
	if (prototype[GROUP_PATCH]) {
		globalState.patchedPrototype = prototype;
		return;
	}
	const original = prototype.render;
	const patched: RenderFunction = function (this: ToolRow, width: number): string[] {
		const toolName = typeof this.toolName === "string" ? this.toolName : "";
		const isFirecodeTool = FIRECODE_TOOLS.has(toolName);
		const isExpanded = Boolean((this as any).expanded);
		const lines = isFirecodeTool || isExpanded
			? original.call(this, width)
			: renderFallbackToolRow(this, width);
		return followsToolRow(this) && lines[0] === "" ? lines.slice(1) : lines;
	};
	Object.defineProperty(prototype, GROUP_PATCH, {
		configurable: true,
		value: { original, patched } satisfies ToolRowPatch,
	});
	prototype.render = patched;
	globalState.patchedPrototype = prototype;
}

export function installGroupPatch(ui: ExtensionUIContext, decorated: Set<string>): void {
	globalState.decorated = decorated;
	globalState.patchErrorReported = false;
	// 借一次 widget 生命周期拿到 tui 实例，拿到即注销。
	ui.setWidget("firecode-tui-capture", (tui) => {
		const patchableTui = tui as TuiLike;
		globalState.tui = patchableTui;
		globalState.chat = undefined;
		globalState.indexedChildren = undefined;
		globalState.joinedRows = undefined;
		if (!patchableTui[REQUEST_RENDER_PATCH]) {
			const original = patchableTui.requestRender;
			const patched: RequestRenderFunction = (force) => {
				try {
					patchToolRows();
				} catch (error) {
					if (!globalState.patchErrorReported) {
						globalState.patchErrorReported = true;
						ui.notify(
							`工具轨道连接失败：${error instanceof Error ? error.message : String(error)}`,
							"warning",
						);
					}
				}
				return original.call(patchableTui, force);
			};
			Object.defineProperty(patchableTui, REQUEST_RENDER_PATCH, {
				configurable: true,
				value: { original, patched } satisfies RequestRenderPatch,
			});
			patchableTui.requestRender = patched;
		}
		patchToolRows();
		return { render: () => [], invalidate: () => {} };
	});
	ui.setWidget("firecode-tui-capture", undefined);
}

export function uninstallGroupPatch(): void {
	const tui = globalState.tui;
	const requestPatch = tui?.[REQUEST_RENDER_PATCH];
	if (tui && requestPatch && tui.requestRender === requestPatch.patched) {
		tui.requestRender = requestPatch.original;
		delete tui[REQUEST_RENDER_PATCH];
	}

	const prototype = globalState.patchedPrototype;
	const rowPatch = prototype?.[GROUP_PATCH];
	if (prototype && rowPatch && prototype.render === rowPatch.patched) {
		prototype.render = rowPatch.original;
		delete prototype[GROUP_PATCH];
	}

	globalState.tui = undefined;
	globalState.chat = undefined;
	globalState.indexedChildren = undefined;
	globalState.indexedLength = undefined;
	globalState.joinedRows = undefined;
	globalState.patchedPrototype = undefined;
	globalState.patchErrorReported = false;
}
