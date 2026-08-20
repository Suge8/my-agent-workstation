#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXCLUDED = new Set([
	".DS_Store", ".git", "search-skills", "archive", "archives", "eval", "evals", "cache", "vendor", "node_modules", "__pycache__",
]);
const PRIVATE = [/\/Users\/[^/\s]+(?:\/|$)/, /\/home\/[^/\s]+(?:\/|$)/, /~\/(?:\.agents|content-create)(?:\/|$)/];

async function exists(path) {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function sanitize(buffer) {
	if (buffer.includes(0)) return buffer;
	return Buffer.from(buffer.toString("utf8")
		.replaceAll(/\/Users\/[^/\s"'`]+/g, "<HOME>")
		.replaceAll(/\/home\/[^/\s"'`]+/g, "<HOME>")
		.replaceAll("~/.agents", "<SKILL_ROOT>")
		.replaceAll("~/content-create", "<VIDEO_PROJECT>")
		.replaceAll(/https:\/\/[A-Za-z0-9]+-dsn\.algolia\.net/g, "https://<ALGOLIA_APP_ID>-dsn.algolia.net")
		.replaceAll(/x-algolia-api-key=[^&\s"'`]+/g, "x-algolia-api-key=<ALGOLIA_API_KEY>")
		.replaceAll(/x-algolia-application-id=[^&\s"'`]+/g, "x-algolia-application-id=<ALGOLIA_APP_ID>"));
}

async function copyTree(source, target, exclude = () => false) {
	const sourceStat = await lstat(source);
	if (sourceStat.isSymbolicLink()) throw new Error(`拒绝同步符号链接：${source}`);
	if (sourceStat.isDirectory()) {
		await mkdir(target, { recursive: true });
		for (const entry of await readdir(source, { withFileTypes: true })) {
			if (EXCLUDED.has(entry.name) || exclude(entry.name, source)) continue;
			if (entry.isSymbolicLink()) throw new Error(`拒绝同步符号链接：${join(source, entry.name)}`);
			await copyTree(join(source, entry.name), join(target, entry.name), exclude);
		}
		return;
	}
	if (!sourceStat.isFile()) throw new Error(`不支持的维护源类型：${source}`);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, sanitize(await readFile(source)));
	await chmod(target, sourceStat.mode & 0o777);
}

function assertManagedPathsClean(root) {
	const paths = ["packages/firecode", "packages/skills", "packages/pi-config/SYSTEM.md"];
	const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=all", "--", ...paths], { cwd: root, encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr.trim() || "无法检查发行快照状态");
	if (result.stdout.trim()) throw new Error(`发行快照有未提交修改，已拒绝覆盖：\n${result.stdout.trim()}`);
}

async function assertPublic(paths) {
	const pending = [...paths];
	while (pending.length) {
		const path = pending.pop();
		const pathStat = await lstat(path);
		if (pathStat.isDirectory()) {
			for (const entry of await readdir(path)) pending.push(join(path, entry));
		} else if (pathStat.isFile()) {
			const content = await readFile(path);
			if (content.includes(0)) continue;
			const text = content.toString("utf8");
			for (const pattern of PRIVATE) if (pattern.test(text)) throw new Error(`发行快照仍含私人路径：${path}`);
		}
	}
}

async function replacePrepared(stage, replacements) {
	const completed = [];
	try {
		for (const [name, target] of replacements) {
			const prepared = join(stage, "next", name);
			const backup = join(stage, "previous", name);
			await mkdir(dirname(backup), { recursive: true });
			if (await exists(target)) await rename(target, backup);
			try {
				await mkdir(dirname(target), { recursive: true });
				await rename(prepared, target);
			} catch (error) {
				if (await exists(backup)) await rename(backup, target);
				throw error;
			}
			completed.push([target, backup]);
		}
	} catch (error) {
		for (const [target, backup] of completed.reverse()) {
			await rm(target, { recursive: true, force: true });
			if (await exists(backup)) await rename(backup, target);
		}
		throw error;
	}
}

export async function syncSources({ root = REPO, firecode, skills, system, checkClean = true }) {
	root = resolve(root);
	firecode = resolve(firecode);
	skills = resolve(skills);
	system = resolve(system);
	if (checkClean) assertManagedPathsClean(root);
	for (const source of [firecode, skills, system]) if (!await exists(source)) throw new Error(`维护源不存在：${source}`);

	const publicConfig = join(root, "packages", "firecode", "config.jsonc");
	const setupSkill = join(root, "packages", "skills", "operations", "workstation-setup");
	for (const overlay of [publicConfig, setupSkill]) if (!await exists(overlay)) throw new Error(`发行覆盖层不存在：${overlay}`);

	const stage = join(root, `.sync-sources.${process.pid}`);
	await rm(stage, { recursive: true, force: true });
	try {
		const next = join(stage, "next");
		await copyTree(firecode, join(next, "firecode"), (name) => name === "config.jsonc");
		await copyFile(publicConfig, join(next, "firecode", "config.jsonc"));
		await copyTree(skills, join(next, "skills"));
		await rm(join(next, "skills", "operations", "workstation-setup"), { recursive: true, force: true });
		await copyTree(setupSkill, join(next, "skills", "operations", "workstation-setup"));
		await copyTree(system, join(next, "SYSTEM.md"));
		await assertPublic([join(next, "firecode"), join(next, "skills"), join(next, "SYSTEM.md")]);
		await replacePrepared(stage, [
			["firecode", join(root, "packages", "firecode")],
			["skills", join(root, "packages", "skills")],
			["SYSTEM.md", join(root, "packages", "pi-config", "SYSTEM.md")],
		]);
	} finally {
		await rm(stage, { recursive: true, force: true });
	}
}

function options(argv) {
	const defaults = {
		firecode: join(homedir(), ".pi", "agent", "extensions", "firecode"),
		skills: join(homedir(), ".agents", "skills"),
		system: join(homedir(), ".pi", "agent", "SYSTEM.md"),
	};
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (!["--firecode", "--skills", "--system"].includes(flag) || !value) throw new Error(`参数无效：${flag ?? ""}`);
		defaults[flag.slice(2)] = value;
	}
	return defaults;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	syncSources(options(process.argv.slice(2)))
		.then(() => process.stdout.write("维护源已同步到发行快照。\n"))
		.catch((error) => {
			process.stderr.write(`${error.message}\n`);
			process.exitCode = 1;
		});
}
