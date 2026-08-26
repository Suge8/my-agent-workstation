/**
 * 在测试里加载 FireCode 模块：扩展运行时由 pi 注入 `@earendil-works/*`，
 * 测试环境没有这层注入，因此把整个插件目录复制到临时目录并把包名改写到 pi 源码。
 */
import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, extname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FIRECODE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE_DIR = FIRECODE_DIR;

function piPackagesDirectory(): string {
	if (process.env.PI_PACKAGES_DIR) return process.env.PI_PACKAGES_DIR;
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		const executable = join(directory, process.platform === "win32" ? "pi.exe" : "pi");
		if (!existsSync(executable)) continue;
		const resolved = realpathSync(executable);
		const marker = `${sep}packages${sep}coding-agent${sep}`;
		const boundary = resolved.lastIndexOf(marker);
		if (boundary >= 0) return join(resolved.slice(0, boundary), "packages");
	}
	throw new Error("Cannot locate Pi sources; set PI_PACKAGES_DIR to the pi-mono packages directory");
}

const PI_PACKAGES = piPackagesDirectory();
export const PI_CODING_AGENT_URL = pathToFileURL(join(PI_PACKAGES, "coding-agent/src/index.ts")).href;
const PI_CODING_AGENT = PI_CODING_AGENT_URL;
export const PI_AI_URL = pathToFileURL(join(PI_PACKAGES, "ai/src/index.ts")).href;
export const PI_AI_COMPAT_URL = pathToFileURL(join(PI_PACKAGES, "ai/src/compat.ts")).href;
const PI_AI = PI_AI_URL;
const PI_TUI = pathToFileURL(join(PI_PACKAGES, "tui/src/index.ts")).href;

const created: string[] = [];
const NON_RUNTIME_ROOTS = new Set([".git", "docs", "tests"]);
export const TEST_REVIEW_CONFIG = {
	advisor: { model: "test/advisor", thinking: "high" },
	reviewers: [{ model: "test/reviewer", thinking: "high" }],
	maxRounds: 3,
	advisorAfterFailures: 2,
	timeoutMinutes: 1,
	tools: ["read", "bash"],
	language: "zh",
};
const TEST_CONFIG_JSONC = JSON.stringify({
	features: {
		header: true,
		statusbar: true,
		tools: true,
		presets: true,
		rename: true,
		stats: true,
		claudeSub: false,
		openaiNative: false,
		workingFlame: true,
		bark: false,
		review: true,
		master: false,
	},
	keys: { rename: "ctrl+r", cyclePreset: "ctrl+shift+u", fast: "ctrl+f" },
	presets: { deep: { thinkingLevel: "high", key: "alt+1" } },
	review: TEST_REVIEW_CONFIG,
});

export async function copyFirecodeSource(destination: string): Promise<void> {
	await cp(SOURCE_DIR, destination, {
		recursive: true,
		filter: (source) => {
			const path = relative(SOURCE_DIR, source);
			const [root] = path.split(sep);
			if (NON_RUNTIME_ROOTS.has(root)) return false;
			if (![".md", ".mdx"].includes(extname(path))) return true;
			return path.startsWith(`review${sep}prompts${sep}`) || path.startsWith(`watcher${sep}prompts${sep}`);
		},
	});
}

async function rewriteImports(directory: string): Promise<void> {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			await rewriteImports(path);
			continue;
		}
		if (!entry.name.endsWith(".ts")) continue;
		const source = (await readFile(path, "utf8"))
			.replaceAll('"@earendil-works/pi-coding-agent"', JSON.stringify(PI_CODING_AGENT))
			.replaceAll('"@earendil-works/pi-ai"', JSON.stringify(PI_AI))
			.replaceAll('"@earendil-works/pi-tui"', JSON.stringify(PI_TUI));
		await writeFile(path, source);
	}
}

/**
 * 加载插件内某个模块，例如 `tools/index.ts`、`session/presets.ts`。
 * `configJsonc` 可覆写或移除测试 Agent 目录里的运行配置，用于验证配置边界。
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
	await copyFirecodeSource(directory);
	const agentDir = join(directory, "agent");
	const configDir = join(agentDir, "extensions", "firecode");
	await mkdir(configDir, { recursive: true });
	if (options.configJsonc !== null) {
		const configJsonc = options.configJsonc ?? TEST_CONFIG_JSONC;
		await writeFile(join(configDir, "config.jsonc"), configJsonc);
	}
	for (const [path, content] of Object.entries(options.extraFiles ?? {})) {
		const destination = join(directory, path);
		await writeFile(destination, content);
	}
	await rewriteImports(directory);
	const configModule = join(directory, "config.ts");
	const getAgentDirImport = `import { getAgentDir } from ${JSON.stringify(PI_CODING_AGENT)};`;
	const configSource = await readFile(configModule, "utf8");
	if (!configSource.includes(getAgentDirImport)) throw new Error("FireCode config path seam changed");
	await writeFile(
		configModule,
		configSource.replace(getAgentDirImport, `const getAgentDir = () => ${JSON.stringify(agentDir)};`),
	);
	for (const [oldText, newText] of Object.entries(options.replacements ?? {})) {
		const sourceEntry = entry.endsWith(".js") ? `${entry.slice(0, -3)}.ts` : entry;
		const path = join(directory, sourceEntry);
		await writeFile(path, (await readFile(path, "utf8")).replace(oldText, newText));
	}
	return import(`${pathToFileURL(join(directory, entry)).href}?test=${Date.now()}`);
}

export async function cleanupFirecodeModules(): Promise<void> {
	await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
}

export const PI_TUI_URL = PI_TUI;
