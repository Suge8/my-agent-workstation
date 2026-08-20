import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { syncSources } from "../scripts/sync-sources.mjs";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function file(path: string, content: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

test("maintainer sync refuses to overwrite a dirty distribution snapshot", async () => {
	const root = mkdtempSync(join(tmpdir(), "myaw-sync-dirty-"));
	roots.push(root);
	file(join(root, "packages", "firecode", "config.jsonc"), "{}\n");
	file(join(root, "packages", "skills", "placeholder"), "clean\n");
	file(join(root, "packages", "pi-config", "SYSTEM.md"), "clean\n");
	expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
	expect(spawnSync("git", ["add", "."], { cwd: root }).status).toBe(0);
	expect(spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base"], { cwd: root }).status).toBe(0);
	writeFileSync(join(root, "packages", "firecode", "config.jsonc"), '{"dirty":true}\n');
	await expect(syncSources({ root, firecode: root, skills: root, system: join(root, "packages", "pi-config", "SYSTEM.md") }))
		.rejects.toThrow("未提交修改");
});

test("maintainer sync mirrors public assets, preserves overlays, and removes private material", async () => {
	const root = mkdtempSync(join(tmpdir(), "myaw-sync-"));
	roots.push(root);
	const sources = join(root, "sources");
	const firecode = join(sources, "firecode");
	const skills = join(sources, "skills");
	const system = join(sources, "SYSTEM.md");
	const targetFirecode = join(root, "packages", "firecode");
	const targetSkills = join(root, "packages", "skills");

	file(join(firecode, "index.ts"), 'export const path = "/Users/alice/private";\n');
	file(join(firecode, "config.jsonc"), '{"private":true}\n');
	file(join(skills, "creative", "video", "SKILL.md"), "Use ~/content-create.\n");
	file(join(skills, "creative", "video", "guide.md"), "x-algolia-api-key=secret&x-algolia-application-id=PRIVATE\n");
	file(join(skills, "search-skills", "SKILL.md"), "private index\n");
	file(join(skills, "creative", "video", "node_modules", "junk.js"), "junk\n");
	file(system, "public system\n");
	file(join(targetFirecode, "config.jsonc"), '{"features":{"review":false}}\n');
	file(join(targetFirecode, "tests", "loader.ts"), "portable loader\n");
	file(join(targetFirecode, "orphan.ts"), "remove me\n");
	file(join(targetSkills, "search", "search", "SKILL.md"), "keychain search\n");
	file(join(targetSkills, "operations", "workstation-setup", "SKILL.md"), "distribution only\n");
	file(join(targetSkills, "orphan", "SKILL.md"), "remove me\n");
	expect(existsSync(join(targetFirecode, "tests", "loader.ts"))).toBe(true);

	await syncSources({ root, firecode, skills, system, checkClean: false });

	expect(readFileSync(join(targetFirecode, "config.jsonc"), "utf8")).toBe('{"features":{"review":false}}\n');
	expect(readFileSync(join(targetFirecode, "tests", "loader.ts"), "utf8")).toBe("portable loader\n");
	expect(readFileSync(join(targetFirecode, "index.ts"), "utf8")).toContain("<HOME>/private");
	expect(existsSync(join(targetFirecode, "orphan.ts"))).toBe(false);
	expect(readFileSync(join(targetSkills, "creative", "video", "SKILL.md"), "utf8")).toContain("<VIDEO_PROJECT>");
	expect(readFileSync(join(targetSkills, "creative", "video", "guide.md"), "utf8")).toContain("<ALGOLIA_API_KEY>");
	expect(existsSync(join(targetSkills, "search-skills"))).toBe(false);
	expect(existsSync(join(targetSkills, "creative", "video", "node_modules"))).toBe(false);
	expect(readFileSync(join(targetSkills, "search", "search", "SKILL.md"), "utf8")).toBe("keychain search\n");
	expect(readFileSync(join(targetSkills, "operations", "workstation-setup", "SKILL.md"), "utf8")).toBe("distribution only\n");
	expect(existsSync(join(targetSkills, "orphan"))).toBe(false);
	expect(readFileSync(join(root, "packages", "pi-config", "SYSTEM.md"), "utf8")).toBe("public system\n");
});
