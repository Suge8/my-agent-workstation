import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIRECODE = join(REPO, "packages", "firecode");
const SKILLS = join(REPO, "packages", "skills");
const PI_CONFIG = join(REPO, "packages", "pi-config");

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function files(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true });
	const paths = await Promise.all(
		entries.map(async (entry) => {
			const path = join(root, entry.name);
			return entry.isDirectory() ? files(path) : [path];
		}),
	);
	return paths.flat();
}

function excludedPath(path: string): boolean {
	return path.split(/[\\/]/).some((part) =>
		new Set([
			".DS_Store",
			".claude",
			"search-skills",
			"archive",
			"archives",
			"eval",
			"cache",
			"vendor",
			"node_modules",
			"__pycache__",
		]).has(part),
	);
}

function skillRoot(path: string): string | undefined {
	let current = dirname(path);
	while (current.startsWith(SKILLS)) {
		if (current !== SKILLS && existsSync(join(current, "SKILL.md"))) return current;
		current = dirname(current);
	}
	return undefined;
}

function localLinks(text: string): string[] {
	const prose = text.replace(/```[\s\S]*?```/g, "");
	return [...prose.matchAll(/\[[^\]]*\]\(([^)\n]+)\)/g)]
		.map((match) => match[1].trim().replace(/^<|>$/g, "").split(/\s+/)[0].split("#", 1)[0])
		.filter((ref) => ref && !ref.startsWith("#") && !ref.startsWith("/") && !/^[a-z][a-z0-9+.-]*:/i.test(ref));
}

const PERSONAL_PATH = /\/Users\/[A-Za-z0-9._-]+(?:\/|$)|\/home\/[A-Za-z0-9._-]+(?:\/|$)/;
const MAINTAINER_PATH = /~\/(?:content-create|\.agents)(?:\/|$)/;
const SECRET_PATTERNS = [
	/-----BEGIN [A-Z ]+ PRIVATE KEY-----/,
	/sk-[A-Za-z0-9]{8,}/,
	/gh[pousr]_[A-Za-z0-9]{20,}/,
	/xox[baprs]-[A-Za-z0-9-]{12,}/,
	/(?:api[_-]?key|access[_-]?token|secret[_-]?key)\s*[:=]\s*["'][A-Za-z0-9+/=_-]{16,}["']/i,
];

const assetRoots = [FIRECODE, PI_CONFIG, SKILLS];
let firecodeLoader: { cleanupFirecodeModules: () => Promise<void> } | undefined;

afterAll(async () => {
	await firecodeLoader?.cleanupFirecodeModules();
});

test("发行包只包含允许的资产范围", async () => {
	const paths = (await Promise.all(assetRoots.map(files))).flat();
	expect(paths.length).toBeGreaterThan(0);
	expect(paths.some((path) => excludedPath(relative(REPO, path)))).toBe(false);
	expect(await exists(join(FIRECODE, "index.ts"))).toBe(true);
	expect(await exists(join(FIRECODE, "AGENTS.md"))).toBe(true);
	expect(await exists(join(FIRECODE, "CONTEXT.md"))).toBe(true);
	expect(await exists(join(PI_CONFIG, "SYSTEM.md"))).toBe(true);
	expect((await files(SKILLS)).filter((path) => basename(path) === "SKILL.md").length).toBeGreaterThan(0);
});

test("发行包没有个人路径或明文密钥", async () => {
	const paths = (await Promise.all(assetRoots.map(files))).flat();
	for (const path of paths) {
		const text = await readFile(path, "utf8");
		expect(text, relative(REPO, path)).not.toMatch(PERSONAL_PATH);
		expect(text, relative(REPO, path)).not.toMatch(MAINTAINER_PATH);
		for (const pattern of SECRET_PATTERNS) expect(text, relative(REPO, path)).not.toMatch(pattern);
	}
});

test("技能 Markdown 相对引用全部可达", async () => {
	for (const path of await files(SKILLS)) {
		if (!path.endsWith(".md")) continue;
		const root = skillRoot(path);
		for (const ref of localLinks(await readFile(path, "utf8"))) {
			const candidates = [resolve(dirname(path), ref)];
			if (root) candidates.push(resolve(root, ref));
			expect(
			candidates.some((candidate) => existsSync(candidate)),
				`${relative(REPO, path)} -> ${ref}`,
			).toBe(true);
		}
	}
});

test("FireCode 通过现有 loader 接缝可加载", async () => {
	const loader = await import("../packages/firecode/tests/loader.ts");
	firecodeLoader = loader;
	expect(loader.PI_TUI_URL).toMatch(/^file:/);
	expect(loader.PI_CODING_AGENT_URL).toMatch(/^file:/);
	const module = await loader.loadFirecodeModule("index.ts");
	expect(typeof module.default).toBe("function");
});

test("FireCode 发行配置不会用未认证示例发起模型调用", async () => {
	const loader = await import("../packages/firecode/tests/loader.ts");
	firecodeLoader = loader;
	const module = await loader.loadFirecodeModule("config.ts");
	const loaded = (module.loadConfig as () => { config: { features: Record<string, boolean> } })();
	expect(loaded.config.features.presets).toBe(false);
	expect(loaded.config.features.master).toBe(false);
	expect(loaded.config.features.review).toBe(false);
});
