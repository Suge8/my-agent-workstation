import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts");

export type MasterPromptKind = "master" | "worker";

export function readMasterPrompt(kind: MasterPromptKind): string {
	let prompt: string;
	try {
		prompt = readFileSync(join(PROMPTS_DIR, `${kind}.zh.md`), "utf8");
	} catch (error) {
		throw new Error(`Master ${kind} prompt 读取失败：${error instanceof Error ? error.message : String(error)}`);
	}
	if (!prompt.trim()) throw new Error(`Master ${kind} prompt 为空`);
	return prompt.trim();
}

export function assembleMasterPrompt(prompt: string, roster: string): string {
	return `${prompt}\n\n角色表：${roster}。`;
}

export function assembleWorkerPrompt(prompt: string, name: string): string {
	return `<firecode_worker name="${name}">\n${prompt}\n</firecode_worker>`;
}
