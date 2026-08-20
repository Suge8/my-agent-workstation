/**
 * 在测试里加载 FireCode 模块：扩展运行时由 pi 注入 `@earendil-works/*`，
 * 测试环境没有这层注入，因此把整个插件目录复制到临时目录；有 PI_SOURCE 时改写到 pi 源码，否则改写到独立的最小运行时 shim 文件。
 */
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 从本文件位置推导插件目录，不能加载全局扩展工作树。
export const FIRECODE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE_DIR = FIRECODE_DIR;
const TEST_HOME = mkdtempSync(join(tmpdir(), "firecode-home-"));
process.env.HOME = TEST_HOME;
process.env.PI_TEST_HOME = TEST_HOME;

const PI_ROOT = process.env.PI_SOURCE;
const PI_PACKAGES = PI_ROOT ? join(PI_ROOT, "packages") : undefined;

const RUNTIME_SHIMS = {
	"@earendil-works/pi-coding-agent": `
export class CustomEditor {
	constructor() {}
	getText() { return ""; }
}
export class DynamicBorder {
	constructor() {}
	render(width) { return ["─".repeat(width)]; }
	invalidate() {}
}
import { readFile } from "node:fs/promises";

export const getAgentDir = () => process.cwd();
export const getMarkdownTheme = () => ({});
export const initTheme = () => {};
export const isToolCallEventType = (toolName, event) => event?.toolName === toolName;
export const buildSessionContext = (entries) => ({ messages: entries ?? [], thinkingLevel: "off", model: null });
export const convertToLlm = (messages) => messages;
const tool = (name) => ({ name, execute: async (_id, params) => ({ content: [{ type: "text", text: params?.path ? await readFile(params.path, "utf8") : "" }] }) });
export const createBashTool = () => tool("bash");
export const createEditTool = () => tool("edit");
export const createReadTool = () => tool("read");
export const createWriteTool = () => tool("write");
`,
	"@earendil-works/pi-ai": `
export const StringEnum = (values) => values;
export const Type = {
	Object: (value) => value,
	Optional: (value) => value,
	String: () => ({}),
	Boolean: () => ({}),
};
`,
	"@earendil-works/pi-tui": `
export const visibleWidth = (value) => String(value).length;
export const truncateToWidth = (value, width, ellipsis = "") =>
	String(value).slice(0, width) + ellipsis;
export const wrapTextWithAnsi = (value) => String(value).split("\\n");
export const matchesKey = () => false;
class Component {
	render() { return []; }
	invalidate() {}
}
export class Box extends Component {
	constructor(_paddingX = 0, _paddingY = 0, transform = (text) => text) {
		super();
		this.children = [];
		this.transform = transform;
	}
	addChild(child) { this.children.push(child); }
	render(width) {
		return this.children
			.flatMap((child) => child.render(width))
			.map(this.transform)
			.map((text) => {
				let output = "";
				for (const char of String(text)) {
					const next = output + char;
					if ((globalThis.Bun?.stringWidth?.(next) ?? next.length) > width) break;
					output = next;
				}
				return output;
			});
	}
}
export class Container extends Box {}
export class Markdown extends Component { constructor(text) { super(); this.text = text; } }
export class Spacer extends Component { render() { return [""]; } }
export class Text extends Component { constructor(text) { super(); this.text = String(text); } render() { return [this.text]; } }
export class SelectList extends Component {}
`,
} as const;

const SOURCE_MODULES = {
	"@earendil-works/pi-coding-agent": PI_PACKAGES && join(PI_PACKAGES, "coding-agent/src/index.ts"),
	"@earendil-works/pi-ai": PI_PACKAGES && join(PI_PACKAGES, "ai/src/index.ts"),
	"@earendil-works/pi-tui": PI_PACKAGES && join(PI_PACKAGES, "tui/src/index.ts"),
} as const;
const needsShims = Object.entries(SOURCE_MODULES).some(([, path]) => !path || !existsSync(path));
const SHIM_ROOT = needsShims ? mkdtempSync(join(tmpdir(), "firecode-shim-")) : undefined;

function moduleUrl(packageName: keyof typeof SOURCE_MODULES, shimFile: string): string {
	const source = SOURCE_MODULES[packageName];
	if (source && existsSync(source)) return pathToFileURL(source).href;
	if (SHIM_ROOT) return pathToFileURL(join(SHIM_ROOT, shimFile)).href;
	return packageName;
}

const PI_CODING_AGENT = moduleUrl("@earendil-works/pi-coding-agent", "pi-coding-agent.js");
export const PI_CODING_AGENT_URL = PI_CODING_AGENT;
const PI_AI = moduleUrl("@earendil-works/pi-ai", "pi-ai.js");
const PI_TUI = moduleUrl("@earendil-works/pi-tui", "pi-tui.js");

if (SHIM_ROOT) {
	for (const [packageName, source] of Object.entries(RUNTIME_SHIMS)) {
		const shimFile = packageName.slice("@earendil-works/".length) + ".js";
		writeFileSync(join(SHIM_ROOT, shimFile), source);
	}
}

let importSequence = 0;
const created: string[] = [];

async function rewriteImports(directory: string, agentDirectory: string): Promise<void> {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			await rewriteImports(path, agentDirectory);
			continue;
		}
		if (!entry.name.endsWith(".ts")) continue;
		const source = (await readFile(path, "utf8"))
			.replaceAll('"@earendil-works/pi-coding-agent"', JSON.stringify(PI_CODING_AGENT))
			.replaceAll('"@earendil-works/pi-ai"', JSON.stringify(PI_AI))
			.replaceAll('"@earendil-works/pi-tui"', JSON.stringify(PI_TUI))
			.replaceAll("getAgentDir()", JSON.stringify(agentDirectory))
			.replaceAll("os.homedir()", "(process.env.PI_TEST_HOME ?? os.homedir())")
			.replace(/(?<!os\.)homedir\(\)/g, "(process.env.PI_TEST_HOME ?? homedir())");
		await writeFile(path, source);
	}
}

/**
 * 加载插件内某个模块，例如 `tools/index.ts`、`session/presets.ts`。
 * 默认把公开模板放入隔离的 Pi Agent 目录；`configJsonc` 可覆写运行配置，null 表示缺失。
 */
export async function loadFirecodeModule(
	entry: string,
	options: {
		configJsonc?: string | null;
		replacements?: Record<string, string>;
		extraFiles?: Record<string, string>;
	} = {},
): Promise<Record<string, unknown>> {
	const directory = await mkdtemp(join(tmpdir(), "firecode-test-"));
	created.push(directory);
	await cp(SOURCE_DIR, directory, { recursive: true });
	await rm(join(directory, "tests"), { recursive: true, force: true });
	const agentDirectory = join(directory, "agent");
	if (options.configJsonc !== null) {
		const config = options.configJsonc ?? await readFile(join(directory, "config.example.jsonc"), "utf8");
		const runtimeDirectory = join(agentDirectory, "extensions", "firecode");
		await mkdir(runtimeDirectory, { recursive: true });
		await writeFile(join(runtimeDirectory, "config.jsonc"), config);
	}
	for (const [path, content] of Object.entries(options.extraFiles ?? {})) {
		const destination = join(directory, path);
		await writeFile(destination, content);
	}
	await rewriteImports(directory, agentDirectory);
	for (const [oldText, newText] of Object.entries(options.replacements ?? {})) {
		const sourceEntry = entry.endsWith(".js") ? `${entry.slice(0, -3)}.ts` : entry;
		const path = join(directory, sourceEntry);
		await writeFile(path, (await readFile(path, "utf8")).replace(oldText, newText));
	}
	return import(`${pathToFileURL(join(directory, entry)).href}?test=${Date.now()}-${++importSequence}`);
}

export async function cleanupFirecodeModules(): Promise<void> {
	await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
}

export const PI_TUI_URL = PI_TUI;
