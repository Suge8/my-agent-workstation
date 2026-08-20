/**
 * 顾问仲裁：连续 N 轮失败后介入，返回 continue | stop | narrow 三选一，
 * 防止审查循环无限拉锯。子进程故障不伪装成仲裁结论，由外层收口为 Review Unavailable。
 */
import type { Language } from "../config.js";
import type { AdvisorResult, AdvisorVerdict } from "./state.js";
import { runPiProcess } from "./process.js";
import type { ReviewModelConfig } from "./reviewer.js";

export interface RunAdvisorOptions {
	config: ReviewModelConfig;
	prompt: string;
	cwd: string;
	language: Language;
	signal?: AbortSignal;
	onEvent?: (event: Record<string, unknown>) => void;
}

export async function runAdvisor(options: RunAdvisorOptions): Promise<AdvisorResult> {
	const result = await runPiProcess({
		command: options.config.command,
		args: advisorArgs(options.config, options.prompt),
		cwd: options.cwd,
		timeoutMs: options.config.timeoutMs,
		signal: options.signal,
		onEvent: options.onEvent,
	});
	if (result.kind !== "output") throw new Error(advisorProcessError(result, options.language));
	return parseAdvisorOutput(result.text, options.language);
}

export function advisorArgs(config: ReviewModelConfig, prompt: string) {
	return [
		"--no-session",
		"--mode",
		"json",
		"--model",
		config.model,
		"--thinking",
		config.thinking,
		"--tools",
		config.tools.join(","),
		"--exclude-tools",
		"write,edit",
		"-p",
		prompt.replaceAll("\0", ""),
	];
}

const VERDICTS = new Set<AdvisorVerdict>(["continue", "stop", "narrow"]);

function advisorProcessError(
	result: Exclude<Awaited<ReturnType<typeof runPiProcess>>, { kind: "output" }>,
	language: Language,
): string {
	const prefix = language === "en" ? "advisor subprocess unavailable" : "顾问子进程不可用";
	if (result.kind === "aborted") return `${prefix}: aborted`;
	if (result.kind === "timeout") return `${prefix}: timeout${result.stderr ? `\n${result.stderr}` : ""}`;
	if (result.kind === "empty") return `${prefix}: empty output${result.stderr ? `\n${result.stderr}` : ""}`;
	return `${prefix}: ${result.message}${result.stderr ? `\n${result.stderr}` : ""}`;
}

/** 首行应为裸裁决词；容忍模型前言，在前几个非空行内识别裁决行，
 * 其余行（含前言）并入 advice；完全识别不出才回落 continue。 */
const VERDICT_SCAN_LINES = 8;

export function parseAdvisorOutput(
	text: string,
	language: Language,
): AdvisorResult {
	const lines = unwrapCodeFence(text.trim().split(/\r?\n/));
	const firstLine = lines.find((line) => line.trim()) ?? "";
	let verdict: AdvisorVerdict | undefined;
	let verdictIndex = -1;
	let scanned = 0;
	for (let index = 0; index < lines.length && scanned < VERDICT_SCAN_LINES; index += 1) {
		if (!lines[index].trim()) continue;
		scanned += 1;
		const parsed = normalizeVerdict(lines[index]);
		if (parsed) {
			verdict = parsed;
			verdictIndex = index;
			break;
		}
	}
	const advice = lines
		.filter((_, index) => index !== verdictIndex)
		.join("\n")
		.trim();
	if (!verdict) {
		// 把首行原文带回去：顾问子进程跑完即退、原始输出不落盘，这是事后诊断解析失败的唯一线索。
		const sample = firstLine.slice(0, 80);
		return {
			verdict: "continue",
			advice:
				language === "en"
					? `Advisor output was not parseable (first line: ${sample}); continuing with the current findings.`
					: `顾问输出无法解析（首行：${sample}），按继续处理当前发现。`,
		};
	}
	return {
		verdict,
		advice: advice || (language === "en" ? "(no advice)" : "（无建议）"),
	};
}

function unwrapCodeFence(lines: string[]) {
	const fenced =
		lines.length >= 2 &&
		/^```\w*\s*$/u.test(lines[0].trim()) &&
		/^```\s*$/u.test(lines.at(-1)?.trim() ?? "");
	return fenced ? lines.slice(1, -1) : lines;
}

function normalizeVerdict(line: string): AdvisorVerdict | undefined {
	const normalized = line
		.trim()
		.replace(/^\*{1,2}(.+?)\*{1,2}$/u, "$1")
		.replace(/^#{1,6}\s*/u, "")
		.replace(/^(?:(?:verdict|裁决|结论)\s*[:：]\s*)/iu, "")
		// 提示词里裁决词本身带反引号展示，模型照抄 `continue` 很常见，剔掉包裹的反引号。
		.replace(/^`+(.+?)`+$/u, "$1")
		.trim()
		.toLowerCase();
	return VERDICTS.has(normalized as AdvisorVerdict)
		? (normalized as AdvisorVerdict)
		: undefined;
}
