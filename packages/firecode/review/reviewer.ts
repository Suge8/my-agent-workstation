/** 审查者：进程内 memory 会话 + PASS/FAIL 输出契约解析。 */
import type { Language, ThinkingLevelValue } from "../config.js";
import type { PromptLayers } from "./prompt.js";
import type { ReviewerResult, ReviewerStatus } from "./state.js";
import type { ReviewSessionRunner } from "./session.js";

export interface ReviewModelConfig {
	model: string;
	thinking: ThinkingLevelValue;
	tools: string[];
	timeoutMs: number;
}

export interface RunReviewerOptions {
	index: number;
	config: ReviewModelConfig;
	prompt: PromptLayers;
	cwd: string;
	language: Language;
	signal?: AbortSignal;
	runSession: ReviewSessionRunner;
	/** 结构化会话事件：驱动活动条的实时进度。 */
	onEvent?: (event: Record<string, unknown>) => void;
}

export type ParseOutcome = {
	status: Exclude<ReviewerStatus, "running">;
	summary: string;
	details: string;
};

/** 运行一个独立审查会话并解析输出。会话故障记为 error，不拖垮整轮。 */
export async function runReviewer(options: RunReviewerOptions): Promise<ReviewerResult> {
	const result = await options.runSession({
		role: "reviewer",
		model: options.config.model,
		thinking: options.config.thinking,
		tools: options.config.tools,
		prompt: options.prompt,
		cwd: options.cwd,
		timeoutMs: options.config.timeoutMs,
		signal: options.signal,
		onEvent: options.onEvent,
	});
	const parsed =
		result.kind === "output"
			? parseReviewOutput(result.text, options.language)
			: processFailure(result, options.language);
	return {
		index: options.index,
		model: options.config.model,
		thinking: options.config.thinking,
		status: parsed.status,
		summary: parsed.summary,
		details: parsed.details,
	};
}

/** 解析审查者文本输出：首行严格 PASS/FAIL + 证据锚点闸门。 */
export function parseReviewOutput(text: string, language: Language): ParseOutcome {
	const trimmed = stripApplyInstruction(text);
	if (!trimmed) return invalidFormat("(empty)", language);
	const [firstLine = "", ...rest] = trimmed.split(/\r?\n/);
	const verdict = verdictOf(firstLine);
	if (verdict === "PASS") {
		const body = rest.join("\n").trim();
		const issue = passIssue(body);
		if (issue) return contractViolation(issue, language);
		const summary = firstSummary(body);
		// passIssue 只保证证据行前有行，那行可能是建议区标题；没有真摘要就是契约违规，
		// 不能让 undefined 流进多模型汇总把循环撞死。
		if (!summary) return contractViolation("PASS 缺少摘要行（证据行前必须有一行极简摘要）", language);
		return { status: "passed", summary, details: body };
	}
	if (verdict === "FAIL") {
		const body = rest.join("\n").trim();
		const issue = failIssue(body, language);
		if (issue) return contractViolation(issue, language);
		return { status: "failed", summary: firstIssue(body, language), details: body };
	}
	return invalidFormat(firstLine.trim() || "(empty)", language);
}

function processFailure(
	result:
		| { kind: "timeout" }
		| { kind: "aborted" }
		| { kind: "error"; message: string }
		| { kind: "empty" },
	language: Language,
): ParseOutcome {
	if (result.kind === "aborted")
		return { status: "error", summary: "", details: "" };
	if (result.kind === "timeout")
		return { status: "error", summary: "", details: systemError(language, "timeout") };
	if (result.kind === "error")
		return {
			status: "error",
			summary: "",
			details: `${systemError(language, "start")}${result.message}`,
		};
	return { status: "error", summary: "", details: systemError(language, "empty") };
}

/** 首行判定失败（既不是 PASS 也不是 FAIL）。 */
function invalidFormat(actual: string, language: Language): ParseOutcome {
	const prefix =
		language === "en"
			? `first line must be PASS or FAIL; actual: `
			: `第一行必须是 PASS 或 FAIL；实际是：`;
	return contractViolation(prefix + tail(actual), language);
}

/** 输出契约违例：该票作废记为基础设施错误，不拖垮整轮。 */
function contractViolation(issue: string, language: Language): ParseOutcome {
	const prefix =
		language === "en" ? "review output format invalid: " : "审查输出格式无效：";
	return { status: "error", summary: "", details: prefix + issue };
}

function systemError(language: Language, kind: "timeout" | "start" | "empty") {
	if (language === "en") {
		if (kind === "timeout") return "review session timed out before returning valid output. ";
		if (kind === "start") return "review session failed. ";
		return "review output is empty: no check result. ";
	}
	if (kind === "timeout") return "审查会话超时，未在时限内返回有效输出。";
	if (kind === "start") return "审查会话失败。";
	return "审查输出为空：无审查结论。";
}

function tail(text: string) {
	return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

// ---- 契约解析（纯函数）----

export function verdictOf(line: string): "PASS" | "FAIL" | undefined {
	const normalized = line
		.trim()
		.replace(/^\*{1,2}(.+?)\*{1,2}$/u, "$1")
		.replace(/^__([^_]+)__$/u, "$1")
		// 与 advisor 同模式：模型把判定词写成 `PASS` 时剔掉包裹的反引号，避免整票误判为格式错误。
		.replace(/^`+(.+?)`+$/u, "$1")
		.trim()
		.toUpperCase();
	return normalized === "PASS" || normalized === "FAIL" ? normalized : undefined;
}

const EVIDENCE_LINE = /^(?:[-*]\s*)?(?:证据：|Evidence:)/u;
const FILE_SEGMENT = /(?:文件|files)\s*=\s*([^;；]*)/iu;
const COMMAND_SEGMENT = /(?:命令|commands)\s*=\s*([^;；]*)/iu;
const FILE_ANCHOR = /[\w@./-]*\w\.[a-zA-Z]\w{0,5}\b/u;
const FINDING_ISSUE = /^[-*+]\s*(?:\*\*)?(?:问题|Issue)(?:\*\*)?\s*[:：]\s*(.*)$/u;
// 不能用 \b 收尾：中文不是\w，「发现 1」里「现」与空格之间不构成词边界。
const FINDING_HEADING = /^#{1,6}\s*(?:发现|Finding)/u;

/**
 * 发现必填字段，事实源是 `prompts/review.{zh,en}.md` 的输出契约。
 * 只校验字段存在且非空，不校验取值（如严重程度写“高危”不应被判非法）。
 */
// 字段标签容忍可选粗体包裹与新旧两套措辞：滚动开放清单里可能混有旧格式发现的复述。
const FINDING_FIELDS = [
	{
		key: "severity",
		zh: "严重程度",
		en: "Severity",
		// 提示词规定阻塞发现只有高/中；低严重度必须进建议区，不得驱动修复循环。
		pattern: /^[-*+]\s*(?:\*\*)?(?:严重程度|Severity)(?:\*\*)?\s*[:：]\s*(?:高|中|High|Medium)\s*$/iu,
	},
	{ key: "issue", zh: "问题", en: "Issue", pattern: /^[-*+]\s*(?:\*\*)?(?:问题|Issue)(?:\*\*)?\s*[:：]\s*(\S.*)$/u },
	{
		key: "evidence",
		zh: "证据",
		en: "Evidence",
		pattern: /^[-*+]\s*(?:\*\*)?(?:证据|Evidence)(?:\*\*)?\s*[:：]\s*(\S.*)$/u,
	},
	{
		key: "contract",
		zh: "违反的约定与期望行为",
		en: "Violated agreement & expected behavior",
		pattern:
			/^[-*+]\s*(?:\*\*)?(?:违反的(?:约定与期望(?:行为)?|契约(?:或期望行为)?)|Violated agreement(?: & expected behavior)?|Contract(?: or expected behavior)? violated)(?:\*\*)?\s*[:：]\s*(\S.*)$/u,
	},
	{
		key: "commands",
		zh: "验证命令",
		en: "Verification command",
		pattern:
			/^[-*+]\s*(?:\*\*)?(?:(?:需要运行的)?验证命令|Verification commands?(?: to run)?)(?:\*\*)?\s*[:：]\s*(\S.*)$/u,
	},
] as const;
const SUGGESTIONS_HEADING = /^##\s+(?:建议（非阻塞）|Suggestions \(non-blocking\))\s*$/iu;

/** PASS 证据锚点闸门：摘要行在前，首个证据行必须同时含文件段（带扩展名）与命令段。 */
export function passIssue(body: string): string | undefined {
	const lines = body
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const evidenceIndex = lines.findIndex((line) => EVIDENCE_LINE.test(line));
	if (evidenceIndex === -1) return "PASS 缺少证据锚点行（证据：文件=…；命令=…）";
	if (evidenceIndex === 0) return "PASS 缺少摘要行（证据行前必须有一行极简摘要）";
	const line = lines[evidenceIndex];
	if (!hasFileSegment(line)) return "PASS 证据行缺少文件段（文件=至少一个带扩展名的路径）";
	if (!hasCommandSegment(line)) return "PASS 证据行缺少命令段（命令=实际运行的命令）";
	return undefined;
}

/**
 * FAIL 发现闸门：至少一条带「问题」的发现，且不能全落在「建议（非阻塞）」区。
 * 空 FAIL 或一段散文都不能驱动执行模型改代码——格式非法的票一律作废为基础设施错误。
 */
export function failIssue(body: string, language: Language): string | undefined {
	const noFinding =
		language === "en"
			? "FAIL has no blocking finding: a `## Finding` section is required"
			: "FAIL 缺少阻塞发现：需要一个「## 发现」小节";
	if (!body) return noFinding;
	const blocking = (body.split(SUGGESTIONS_HEADING_SPLIT)[0] ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim());
	const starts = blocking
		.map((line, index) => (FINDING_HEADING.test(line) ? index : -1))
		.filter((index) => index >= 0);
	if (starts.length === 0) return noFinding;
	// 每条发现都必须满足完整契约；同票混入非法发现整票作废。
	// 契约完整才能驱动自动修复：半成品票据无法核实，也无法验收。
	for (const [order, start] of starts.entries()) {
		const end = starts[order + 1] ?? blocking.length;
		const section = blocking.slice(start, end);
		const missing = FINDING_FIELDS.filter(
			(field) => !sectionHasField(section, field),
		);
		if (missing.length > 0)
			return missingFieldsMessage(order + 1, missing, language);
	}
	return undefined;
}

function sectionHasField(section: readonly string[], field: (typeof FINDING_FIELDS)[number]): boolean {
	for (let i = 0; i < section.length; i += 1) {
		const line = section[i] ?? "";
		if (field.pattern.test(line)) return true;
		if (field.key === "severity") continue;
		const tagSource = field.pattern.source.replace(/\s*\(\\S\.\*\)\$/u, "\\s*");
		const tagPattern = new RegExp(tagSource, "iu");
		if (tagPattern.test(line)) {
			const inline = line.replace(tagPattern, "").trim();
			if (inline) return true;
			for (let j = i + 1; j < section.length; j += 1) {
				const nextLine = (section[j] ?? "").trim();
				if (/^[-*+]\s*(?:\*\*)?(?:严重程度|Severity|问题|Issue|证据|Evidence|违反|Violated|Contract|验证|Verification)/iu.test(nextLine) || /^#{1,6}\s+/u.test(nextLine)) {
					break;
				}
				if (nextLine) return true;
			}
		}
	}
	return false;
}

function missingFieldsMessage(
	index: number,
	missing: readonly (typeof FINDING_FIELDS)[number][],
	language: Language,
) {
	const names = missing
		.map((field) => (language === "en" ? field.en : field.zh))
		.join(language === "en" ? ", " : "、");
	return language === "en"
		? `FAIL finding ${index} is missing required fields: ${names}`
		: `FAIL 第 ${index} 条发现缺少必填字段：${names}`;
}

const SUGGESTIONS_HEADING_SPLIT =
	/^##\s+(?:建议（非阻塞）|Suggestions \(non-blocking\))\s*$/imu;

function hasFileSegment(line: string) {
	const segment = FILE_SEGMENT.exec(line)?.[1];
	return Boolean(segment && FILE_ANCHOR.test(segment));
}

function hasCommandSegment(line: string) {
	return Boolean(COMMAND_SEGMENT.exec(line)?.[1]?.trim());
}

/** 汇总摘要：剥离证据锚点行与建议区后的首行。 */
function firstSummary(body: string) {
	return body
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !EVIDENCE_LINE.test(line) && !SUGGESTIONS_HEADING.test(line))[0];
}

/** 发现一句话问题（FAIL 卡片回顾用）：取第一条「- 问题:」行（支持同行及换行）。 */
function firstIssue(body: string, language: Language) {
	const lines = body.split(/\r?\n/).map((line) => line.trim());
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		const match = FINDING_ISSUE.exec(line);
		if (match) {
			if (match[1]?.trim()) return clean(match[1]);
			for (let j = i + 1; j < lines.length; j += 1) {
				const nextLine = lines[j] ?? "";
				if (/^[-*+]\s+/u.test(nextLine) || /^#{1,6}\s+/u.test(nextLine)) break;
				if (nextLine.trim()) return clean(nextLine);
			}
		}
	}
	return language === "en" ? "Review failed with findings." : "审查未通过，存在发现。";
}

function clean(text: string) {
	return text.replace(/`([^`]+)`/gu, "$1").trim();
}

/** 去掉模型可能夹带的"应用反馈"指令尾巴（防执行模型把修复指令回传给审查者）。 */
function stripApplyInstruction(text: string) {
	return removeWhitespaceInsensitive(
		removeWhitespaceInsensitive(text, APPLY_INSTRUCTION_ZH),
		APPLY_INSTRUCTION_EN,
	)
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

const APPLY_INSTRUCTION_ZH =
	"将审查反馈视为待核实假设，而非事实；先基于当前文件、测试/检查输出和会话约束核实。反馈属实时，逐条修复全部属实发现，修根因而非表象，同一根因的其他出现点一并修复，修完端到端验证问题已彻底解决再结束，避免无关重构、抽象、依赖或风格改动；反馈不成立时，不应用该反馈，并说明依据（文件、命令输出或约束）。";
const APPLY_INSTRUCTION_EN =
	"Treat the review feedback as hypotheses to verify, not facts; verify against current files, test/check output and session constraints. When feedback is valid, fix every valid finding, fixing root causes not symptoms, fixing other occurrences of the same root cause too, and verify end-to-end that issues are truly resolved before finishing; avoid unrelated refactors, abstractions, dependency or style changes. When feedback is not valid, do not apply it and explain why (files, command output, or constraints).";

function removeWhitespaceInsensitive(text: string, needle: string) {
	let result = "";
	let index = 0;
	while (index < text.length) {
		const matchEnd = whitespaceInsensitiveMatchEnd(text, needle, index);
		if (matchEnd === undefined) {
			result += text[index];
			index += 1;
			continue;
		}
		index = matchEnd;
	}
	return result;
}

function whitespaceInsensitiveMatchEnd(text: string, needle: string, start: number) {
	let textIndex = start;
	for (const char of needle) {
		while (textIndex < text.length && /\s/.test(text[textIndex])) textIndex += 1;
		if (text[textIndex] !== char) return undefined;
		textIndex += 1;
	}
	return textIndex;
}
