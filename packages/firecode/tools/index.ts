/**
 * 接管默认 4 工具（read/bash/edit/write）的展示：单行摘要 + 耗时/大小列 + 连续行轨道。
 *
 * 只包装默认激活的工具：原版 pi 的 registerTool 是注册即激活（会话构建与 reload
 * 固定 includeAllExtensionTools），给 grep/find/ls 挂渲染包装会把它们在所有会话
 * 强制打开——渲染接管不得改变工具集，因此那三个用宿主默认渲染。
 */
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { installGroupPatch, uninstallGroupPatch } from "./grouping.js";
import { ToolLine, makeResultRenderer } from "./line.js";
import { commandParts, diffMeta, pathValue } from "./parts.js";
import { clearDurations, executeTimed } from "./timing.js";

const LABEL = { read: "读取", bash: "操作", edit: "修改", write: "写入" } as const;

type ToolArgs = {
	path?: string;
	file_path?: string;
	offset?: number;
	limit?: number;
};

type ToolMap = {
	read: ReturnType<typeof createReadTool>;
	bash: ReturnType<typeof createBashTool>;
	edit: ReturnType<typeof createEditTool>;
	write: ReturnType<typeof createWriteTool>;
};

const cache = new Map<string, ToolMap>();

function createTools(cwd: string): ToolMap {
	return {
		read: createReadTool(cwd),
		bash: createBashTool(cwd),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
	};
}

/** 工具实例按 cwd 复用：同一会话内 cwd 不变，切目录也不必重建全部工具。 */
function tools(cwd: string): ToolMap {
	let value = cache.get(cwd);
	if (!value) {
		value = createTools(cwd);
		cache.set(cwd, value);
	}
	return value;
}

const argPath = (args: ToolArgs): string => args?.file_path ?? args?.path ?? "";

/** read 的 offset/limit → `:12-40`、`:12+`。 */
function rangeSuffix(args: ToolArgs): string {
	if (args.offset === undefined && args.limit === undefined) return "";
	const start = args.offset ?? 1;
	if (args.limit === undefined) return `:${start}+`;
	return `:${start}-${start + args.limit - 1}`;
}

function lineCount(text: string): number {
	if (text === "") return 0;
	const lines = text.split("\n").length;
	return text.endsWith("\n") ? lines - 1 : lines;
}

function invoke<T extends (...args: never[]) => unknown>(
	execute: T,
	args: unknown[],
): ReturnType<T> {
	return Reflect.apply(execute, undefined, args) as ReturnType<T>;
}

export function registerToolRendering(pi: ExtensionAPI): void {
	const initial = tools(process.cwd());
	const decorated = new Set<string>(Object.keys(LABEL));

	pi.on("session_start", async (_event, ctx) => {
		clearDurations();
		for (const tool of pi.getAllTools()) {
			decorated.add(tool.name);
		}
		installGroupPatch(ctx.ui, decorated);
	});
	pi.on("session_shutdown", async () => {
		clearDurations();
		uninstallGroupPatch();
	});

	pi.registerTool({
		...initial.read,
		label: LABEL.read,
		renderShell: "self",
		execute: (id, params, signal, update, ctx) =>
			executeTimed(id, () => invoke(tools(ctx.cwd).read.execute, [id, params, signal, update, ctx])),
		renderCall: (args, theme, ctx) =>
			new ToolLine({
				label: LABEL.read,
				value: pathValue(argPath(args), ctx.cwd, rangeSuffix(args)),
				clip: "start",
				theme,
				ctx,
			}),
		renderResult: makeResultRenderer(true),
	});

	pi.registerTool({
		...initial.bash,
		label: LABEL.bash,
		renderShell: "self",
		execute: (id, params, signal, update, ctx) =>
			executeTimed(id, () => invoke(tools(ctx.cwd).bash.execute, [id, params, signal, update, ctx])),
		renderCall: (args, theme, ctx) =>
			new ToolLine({
				label: LABEL.bash,
				value: commandParts(args.command),
				clip: "end",
				theme,
				ctx,
			}),
		renderResult: makeResultRenderer(true),
	});

	const editResult = makeResultRenderer(false);
	pi.registerTool({
		...initial.edit,
		label: LABEL.edit,
		renderShell: "self",
		execute: (id, params, signal, update, ctx) =>
			executeTimed(id, () => invoke(tools(ctx.cwd).edit.execute, [id, params, signal, update, ctx])),
		renderCall: (args, theme, ctx) =>
			new ToolLine({
				label: LABEL.edit,
				value: pathValue(argPath(args), ctx.cwd),
				clip: "start",
				theme,
				ctx,
			}),
		renderResult(result, options, theme, ctx) {
			const details = result.details as { diff?: unknown } | undefined;
			const diff = !ctx.isError && typeof details?.diff === "string" ? details.diff : undefined;
			ctx.state.meta = diff ? diffMeta(diff) : undefined;
			return editResult(result, options, theme, ctx);
		},
	});

	pi.registerTool({
		...initial.write,
		label: LABEL.write,
		renderShell: "self",
		execute: (id, params, signal, update, ctx) =>
			executeTimed(id, () => invoke(tools(ctx.cwd).write.execute, [id, params, signal, update, ctx])),
		renderCall: (args, theme, ctx) =>
			new ToolLine({
				label: LABEL.write,
				value: pathValue(argPath(args), ctx.cwd),
				clip: "start",
				meta: [{ text: ` +${lineCount(args.content ?? "")}`, color: "toolDiffAdded" }],
				theme,
				ctx,
			}),
		renderResult: makeResultRenderer(false),
	});

	pi.registerCommand("tool-status", {
		description: "显示当前已加载/启用工具",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				`active: ${pi.getActiveTools().join(", ")}\nall: ${pi
					.getAllTools()
					.map((tool) => tool.name)
					.join(", ")}`,
				"info",
			);
		},
	});
}
