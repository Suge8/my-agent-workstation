/**
 * 会话证据组装：取会话分支 entries 转纯文本，按 token 预算裁剪。
 *
 * 根因规避：首条用户消息是原始需求锚点，固定保留，不参与预算竞争；
 * 预算只裁剪中间的旧消息，从最新往前保留最近工作，审查者既知道要什么也知道做了什么。
 * assistant 的工具调用轨迹（工具名 + path/command）随消息渲染：它是范围归因的一手证据，
 * 审查者靠它判断本会话实际编辑了什么，共享 checkout 上无法归因的 diff 不得立案。
 * isError 的调用标注失败：尝试过不等于编辑成功，失败调用不得成为归因依据；
 * 无结果的调用不标——把压缩/中止场景的真实编辑误标未完成，会反向把归因弱化成假 PASS。
 * toolResult 正文仍跳过（输出体积大且非一手证据——审查者应自行重跑验证命令）。
 */
import type { Language } from "../config.js";

export const DEFAULT_EVIDENCE_TOKENS = 24_000;
/** 单条消息渲染上限，防单条超长消息撑爆预算。 */
const MESSAGE_MAX_CHARS = 3_000;

export interface Evidence {
	text: string;
	/** 被预算裁剪掉的中间消息条数。 */
	omitted: number;
}

export function buildEvidence(
	entries: readonly unknown[],
	language: Language,
	budgetTokens = DEFAULT_EVIDENCE_TOKENS,
): Evidence {
	const failedCalls = collectFailedCalls(entries);
	const blocks = entries.flatMap((entry) => renderEntry(entry, language, failedCalls));
	if (blocks.length === 0) return { text: "", omitted: 0 };
	// 锚点必须是首条用户消息（原始需求）：它之前可能排着其他扩展的可显示消息，
	// 盲取第一块会把真正的需求锚点让进预算竞争、在长会话里被裁掉。
	const anchorIndex = Math.max(
		0,
		blocks.findIndex((block) => block.role === "user"),
	);
	const anchor = blocks[anchorIndex];
	const rest = blocks.filter((_, index) => index !== anchorIndex);
	const recent: string[] = [];
	let used = estimateTokens(anchor.text);
	let omitted = 0;
	for (let index = rest.length - 1; index >= 0; index -= 1) {
		const block = rest[index];
		const cost = estimateTokens(block.text);
		if (used + cost > budgetTokens) {
			omitted += 1;
			continue;
		}
		recent.push(block.text);
		used += cost;
	}
	recent.reverse();
	const text =
		recent.length === 0
			? anchor.text
			: `${anchor.text}\n\n${omitted > 0 ? gapLabel(omitted, language) : ""}${recent.join("\n\n")}`;
	return { text, omitted };
}

function gapLabel(omitted: number, language: Language) {
	return language === "en"
		? `[${omitted} intermediate message(s) omitted under the evidence budget]\n\n`
		: `[证据预算省略了 ${omitted} 条中间消息]\n\n`;
}

type EvidenceBlock = { text: string; role?: "user" };

/** isError 的 toolResult 集合：失败调用不得在轨迹里冒充实际编辑。 */
function collectFailedCalls(entries: readonly unknown[]): ReadonlySet<string> {
	const failed = new Set<string>();
	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "message") continue;
		const message = asRecord(entry.message);
		if (message?.role !== "toolResult" || message.isError !== true) continue;
		if (typeof message.toolCallId === "string") failed.add(message.toolCallId);
	}
	return failed;
}

function renderEntry(
	entry: unknown,
	language: Language,
	failedCalls: ReadonlySet<string>,
): EvidenceBlock[] {
	if (!isRecord(entry)) return [];
	switch (entry.type) {
		case "message": {
			const message = asRecord(entry.message);
			if (!message) return [];
			if (message.role === "user")
				return [
					{
						text: `## ${userLabel(language)}\n${clip(messageText(message.content))}`,
						role: "user" as const,
					},
				];
			if (message.role === "assistant")
				return [{ text: `## ${assistantLabel(language)}\n${assistantBody(message.content, language, failedCalls)}` }];
			return [];
		}
		case "custom_message": {
			if (entry.display !== true) return [];
			return [{ text: `## ${customLabel(language, String(entry.customType ?? ""))}\n${clip(messageText(entry.content))}` }];
		}
		case "compaction":
			return typeof entry.summary === "string" && entry.summary
				? [{ text: `## ${summaryLabel(language)}\n${clip(entry.summary)}` }]
				: [];
		case "branch_summary":
			return typeof entry.summary === "string" && entry.summary
				? [{ text: `## ${branchSummaryLabel(language)}\n${clip(entry.summary)}` }]
				: [];
		default:
			return [];
	}
}

function userLabel(language: Language) {
	return language === "en" ? "User" : "用户";
}

function assistantLabel(language: Language) {
	return language === "en" ? "Assistant" : "助手";
}

function customLabel(language: Language, customType: string) {
	return language === "en" ? `Message (${customType})` : `消息（${customType}）`;
}

function summaryLabel(language: Language) {
	return language === "en" ? "History summary (compacted)" : "历史摘要（已压缩）";
}

function branchSummaryLabel(language: Language) {
	return language === "en" ? "Branch summary" : "分支摘要";
}

/** assistant 正文 = 文本段 + 工具调用轨迹；纯工具回合也因此留下编辑记录。 */
function assistantBody(
	content: unknown,
	language: Language,
	failedCalls: ReadonlySet<string>,
): string {
	if (typeof content === "string") return clip(content);
	if (!Array.isArray(content)) return "";
	const trail = content
		.map((part) => toolCallLine(asRecord(part), language, failedCalls))
		.filter(Boolean)
		.join("\n");
	const body = clip(messageText(content));
	return [body, trail].filter(Boolean).join("\n");
}

function toolCallLine(
	part: Record<string, unknown> | undefined,
	language: Language,
	failedCalls: ReadonlySet<string>,
): string {
	if (part?.type !== "toolCall" || typeof part.name !== "string" || !part.name) return "";
	const args = asRecord(part.arguments);
	const target =
		typeof args?.path === "string"
			? args.path
			: typeof args?.command === "string"
				? args.command
				: "";
	const failed =
		typeof part.id === "string" && failedCalls.has(part.id)
			? language === "en"
				? " (failed)"
				: "（失败）"
			: "";
	return `${`[${part.name}] ${clipLine(target)}`.trimEnd()}${failed}`;
}

/** 单行轨迹上限：防超长 bash 命令撑大证据块；路径不受影响。 */
const TOOL_LINE_MAX_CHARS = 200;

function clipLine(text: string) {
	const single = text.replace(/\s+/gu, " ").trim();
	return single.length <= TOOL_LINE_MAX_CHARS ? single : `${single.slice(0, TOOL_LINE_MAX_CHARS)}…`;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const record = asRecord(part);
			return record?.type === "text" && typeof record.text === "string"
				? record.text
				: "";
		})
		.join("\n");
}

function clip(text: string) {
	if (text.length <= MESSAGE_MAX_CHARS) return text.trim();
	return `${text.slice(0, MESSAGE_MAX_CHARS).trim()}\n[…]`;
}

/**
 * 粗略 token 估计：CJK 每字 1 token，其余按 4 字符/token。
 * 用于预算裁剪的相对量级，不追求精确。
 */
export function estimateTokens(text: string): number {
	let cjk = 0;
	let other = 0;
	for (const char of text) {
		if (isCjk(char)) cjk += 1;
		else other += 1;
	}
	return Math.ceil(cjk + other / 4);
}

function isCjk(char: string) {
	const code = char.codePointAt(0) ?? 0;
	return (
		(code >= 0x4e00 && code <= 0x9fff) ||
		(code >= 0x3400 && code <= 0x4dbf) ||
		(code >= 0xf900 && code <= 0xfaff)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}
