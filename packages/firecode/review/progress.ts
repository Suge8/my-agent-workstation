/**
 * 审查者实时进度：从子进程事件流派生的 UI 层状态（纯函数）。
 *
 * 不进 reducer、不写 checkpoint：更新频率是每次工具调用，持久化它只会放大写入，
 * 而它对恢复毫无价值——重启后由 reducer 状态重建骨架即可，丢掉的只是流水。
 */
import { clip, formatModelName } from "../format.js";
import type { Language } from "../config.js";
import type { ReviewerStatus } from "./state.js";

export interface ProgressTool {
	id: string;
	tool: string;
	args: string;
	startedAt: number;
	endedAt?: number;
	isError?: boolean;
}

/** 单个审查者的活动快照。 */
export interface ReviewerProgress {
	index: number;
	label: string;
	status: ReviewerStatus;
	/** 当前动作的人话描述（读某文件 / 跑某命令 / 思考中）。 */
	action: string;
	/** 落定后的一行结果摘要（PASS 收敛摘要 / FAIL 首条发现）；运行中为空。 */
	summary: string;
	/** 落定后的结构化多行人话结论与建议（不含命令参数等机械流水）。 */
	details?: string[];
	toolCalls: number;
	tokens: number;
	activeTools: ProgressTool[];
	recentTools: ProgressTool[];
	/** 最近动作流水，供活动测试和降级展示。 */
	trail: string[];
	/** 本模型启动时刻；活动条据此显示每个模型自己的耗时。 */
	startedAt: number;
	/** 落定时刻；落定后耗时冻结在 settledAt - startedAt。 */
	settledAt?: number;
}

const TRAIL_LIMIT = 40;
const RECENT_TOOL_LIMIT = 5;
const ACTION_WIDTH = 48;

export function initialProgress(
	reviewers: readonly { model: string }[],
	language: Language,
	now = Date.now(),
): ReviewerProgress[] {
	return reviewers.map((reviewer, index) => ({
		index,
		label: formatModelName(reviewer.model),
		status: "running",
		action: thinkingText(language),
		summary: "",
		toolCalls: 0,
		tokens: 0,
		activeTools: [],
		recentTools: [],
		trail: [],
		startedAt: now,
	}));
}

/**
 * 把一条子进程事件并入进度快照，返回新数组（无事件相关变化时返回原数组，
 * 调用方据此跳过重绘）。
 */
export function applyProcessEvent(
	progress: readonly ReviewerProgress[],
	index: number,
	event: Record<string, unknown>,
	language: Language,
): readonly ReviewerProgress[] {
	const current = progress.find((item) => item.index === index);
	if (!current) return progress;
	const next = applyReviewerEvent(current, event, language);
	if (next === current) return progress;
	return progress.map((item) => item.index === index ? next : item);
}

function applyReviewerEvent(
	item: ReviewerProgress,
	event: Record<string, unknown>,
	language: Language,
): ReviewerProgress {
	if (event.type === "tool_execution_start") {
		const tool = typeof event.toolName === "string" ? event.toolName : "tool";
		const args = summarizeArgs(event.args);
		const active: ProgressTool = {
			id: typeof event.toolCallId === "string" ? event.toolCallId : `${tool}:${Date.now()}`,
			tool,
			args,
			startedAt: Date.now(),
		};
		const action = actionOf(tool, args, language);
		return {
			...item,
			action,
			toolCalls: item.toolCalls + 1,
			activeTools: [...item.activeTools, active],
			trail: [...item.trail, action].slice(-TRAIL_LIMIT),
		};
	}
	if (event.type === "tool_execution_end") {
		const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
		const completed = item.activeTools.find((tool) => tool.id === id);
		if (!completed) return item;
		const activeTools = item.activeTools.filter((tool) => tool.id !== id);
		const current = activeTools.at(-1);
		return {
			...item,
			action: current ? actionOf(current.tool, current.args, language) : thinkingText(language),
			activeTools,
			recentTools: [
				...item.recentTools,
				{ ...completed, endedAt: Date.now(), isError: event.isError === true },
			].slice(-RECENT_TOOL_LIMIT),
		};
	}
	if (event.type === "message_end") {
		const message = isRecord(event.message) ? event.message : {};
		const usage = isRecord(message.usage) ? message.usage : {};
		const tokens = Number.isFinite(usage.totalTokens) ? Number(usage.totalTokens) : 0;
		return tokens ? { ...item, tokens: item.tokens + tokens } : item;
	}
	return item;
}

export function settleProgress(
	progress: readonly ReviewerProgress[],
	index: number,
	status: ReviewerStatus,
	language: Language,
	summary = "",
	rawDetails = "",
): readonly ReviewerProgress[] {
	const details = extractReviewDetails(status, summary, rawDetails, language);
	return progress.map((item) =>
		item.index === index
			? {
					...item,
					status,
					action: settledText(status, language),
					summary: oneLine(summary) || (details[0] ?? settledText(status, language)),
					details,
					activeTools: [],
					settledAt: Date.now(),
				}
			: item,
	);
}

export function extractReviewDetails(
	status: ReviewerStatus,
	summary: string,
	rawDetails = "",
	language: Language = "zh",
): string[] {
	const lines: string[] = [];
	const cleanSummary = summary.trim();

	if (status === "passed") {
		if (cleanSummary) {
			lines.push(cleanSummary);
		}
		if (rawDetails) {
			const suggestionSections = rawDetails.split(/^##\s+(?:建议（非阻塞）|Suggestions \(non-blocking\))\s*$/imu);
			if (suggestionSections.length > 1) {
				const suggestionBody = suggestionSections.slice(1).join("\n");
				for (const line of suggestionBody.split(/\r?\n/)) {
					const trimmed = line.trim();
					if (/^[-*+]\s+/u.test(trimmed)) {
						const text = trimmed.replace(/^[-*+]\s+/u, "").trim();
						if (text) {
							lines.push(language === "en" ? `Suggestion: ${text}` : `建议：${text}`);
						}
					}
				}
			}
		}
	} else if (status === "failed") {
		// 只列发现标题（带严重度标签），首行是数量汇总；问题正文留给结果卡。
		if (rawDetails) {
			const rawFindings = rawDetails.split(/^##\s+(?:建议（非阻塞）|Suggestions \(non-blocking\))\s*$/imu)[0] ?? "";
			const rawSections = rawFindings.split(/\n(?=#{1,6}\s*(?:发现|Finding))/imu);
			const findings: string[] = [];
			for (const section of rawSections) {
				const rawLines = section.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
				if (rawLines.length === 0 || !/^#{1,6}\s*(?:发现|Finding)/iu.test(rawLines[0] ?? "")) {
					continue;
				}
				const heading = (rawLines[0] ?? "").replace(/^#{1,6}\s*(?:发现|Finding)\s*(?:\d+|[a-zA-Z0-9]+)?\s*[:：]?\s*/iu, "").trim();
				let severity = "";
				const issueLines: string[] = [];
				let inIssue = false;
				for (let i = 1; i < rawLines.length; i += 1) {
					const line = rawLines[i] ?? "";
					const sevMatch = /^[-*+]\s*(?:\*\*)?(?:严重程度|Severity)(?:\*\*)?\s*[:：]\s*(高|中|低|High|Medium|Low)/iu.exec(line);
					if (sevMatch) {
						severity = sevMatch[1] ?? "";
						inIssue = false;
						continue;
					}
					const issueStart = /^[-*+]\s*(?:\*\*)?(?:问题|Issue)(?:\*\*)?\s*[:：]\s*(.*)$/u.exec(line);
					if (issueStart) {
						inIssue = true;
						if (issueStart[1]?.trim()) issueLines.push(issueStart[1].trim());
						continue;
					}
					if (/^[-*+]\s*(?:\*\*)?(?:违反|证据|验证|Violated|Evidence|Verification)/iu.test(line) || /^#{1,6}\s+/u.test(line)) {
						inIssue = false;
						continue;
					}
					if (inIssue && line) issueLines.push(line.replace(/^[-*+]\s*/u, ""));
				}
				const issueText = issueLines.join(" ").replace(/`([^`]+)`/gu, "$1").trim();
				const title = heading || issueText;
				if (!title) continue;
				const sevTag = severity
					? `[${language === "en" ? severity : `严重·${severity}`}] `
					: "";
				findings.push(`${sevTag}${title}`);
			}
			if (findings.length > 0) {
				lines.push(
					language === "en"
						? `Found ${findings.length} issue${findings.length === 1 ? "" : "s"}`
						: `发现 ${findings.length} 个问题`,
					...findings,
				);
			}
		}
		if (lines.length === 0 && cleanSummary) {
			lines.push(cleanSummary);
		}
	}

	return lines.length > 0 ? lines : [cleanSummary || settledText(status, language)];
}

/** 工具调用事件 → 人话动作；非工具事件返回 undefined。 */
function actionOf(tool: string, args: string, language: Language) {
	const verb = verbOf(tool, language);
	const target = tool === "bash" ? args : basename(args);
	return clip(target ? `${verb} ${target}` : verb, ACTION_WIDTH);
}

function verbOf(tool: string, language: Language) {
	const zh: Record<string, string> = {
		read: "读",
		bash: "跑",
		grep: "搜",
		find: "找",
		ls: "看",
	};
	const en: Record<string, string> = {
		read: "read",
		bash: "run",
		grep: "grep",
		find: "find",
		ls: "ls",
	};
	const table = language === "en" ? en : zh;
	return table[tool] ?? tool ?? "?";
}

function summarizeArgs(value: unknown) {
	const args = isRecord(value) ? value : {};
	const raw =
		firstString(args, ["command"]) ??
		firstString(args, ["path", "pattern", "query", "file"]);
	if (raw) return oneLine(raw);
	if (value === undefined) return "";
	try {
		const serialized = JSON.stringify(value);
		return serialized === "{}" ? "" : clip(serialized, 100);
	} catch {
		return clip(String(value), 100);
	}
}

function firstString(args: Record<string, unknown>, keys: readonly string[]) {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function basename(path: string) {
	const parts = path.split("/").filter(Boolean);
	return parts.length > 1 ? `${parts.at(-2)}/${parts.at(-1)}` : (parts.at(-1) ?? path);
}

function oneLine(text: string) {
	return text.replace(/\s+/gu, " ").trim();
}

function thinkingText(language: Language) {
	return language === "en" ? "thinking" : "思考中";
}

function settledText(status: ReviewerStatus, language: Language) {
	if (language === "en")
		return status === "passed"
			? "passed"
			: status === "failed"
				? "found issues"
				: status === "error"
					? "infra error"
					: "thinking";
	return status === "passed"
		? "通过"
		: status === "failed"
			? "发现问题"
			: status === "error"
				? "异常"
				: "思考中";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
