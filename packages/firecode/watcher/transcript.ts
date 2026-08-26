/**
 * 主会话回合的增量渲染：喂给观察会话的唯一素材，纯函数。
 * minimal 省略 reasoning 与 diff 展开正文——观察员要的是「在做什么」，正文可以自己去读。
 */
import type { TurnEndEvent } from "@earendil-works/pi-coding-agent";
import type { WatcherContext } from "../config.js";

const RESULT_BUDGET = 400;

export function renderTurn(turn: TurnEndEvent, context: WatcherContext): string {
	const lines: string[] = [];
	for (const part of blocks(turn.message.content)) {
		if (part.type === "text" && typeof part.text === "string" && part.text.trim())
			lines.push(part.text.trim());
		if (part.type === "thinking" && context === "full" && typeof part.thinking === "string")
			lines.push(`（思考）${part.thinking.trim()}`);
		if (part.type === "toolCall") lines.push(toolCallLine(part, context));
	}
	for (const result of turn.toolResults) {
		const text = clipText(plainText(result.content), RESULT_BUDGET);
		lines.push(`${result.isError ? "✗" : "→"} ${result.toolName}：${text || "（无输出）"}`);
	}
	return `<turn index="${turn.turnIndex}">\n${lines.join("\n")}\n</turn>`;
}

function toolCallLine(part: Record<string, any>, context: WatcherContext): string {
	const args = part.arguments && typeof part.arguments === "object" ? part.arguments : {};
	const summary = Object.entries(args as Record<string, unknown>)
		.map(([key, value]) => `${key}=${clipText(argumentText(key, value, context), 200)}`)
		.join(" ");
	return `· ${part.name ?? "工具"} ${summary}`.trimEnd();
}

/** minimal 下 edit/write 的正文（新旧内容）只留长度：观察员判断的是动作，不是逐字 diff。 */
function argumentText(key: string, value: unknown, context: WatcherContext): string {
	const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
	if (context === "full") return oneLine(text);
	return BODY_KEYS.has(key) ? `<${text.length} 字符>` : oneLine(text);
}

const BODY_KEYS = new Set(["content", "oldText", "newText", "old_text", "new_text", "edits"]);

function blocks(content: unknown): Array<Record<string, any>> {
	return Array.isArray(content) ? content.filter((part) => !!part && typeof part === "object") : [];
}

function plainText(output: unknown): string {
	if (typeof output === "string") return output;
	if (Array.isArray(output))
		return output
			.map((part) => (part && typeof part === "object" && "text" in part ? String((part as any).text) : ""))
			.filter(Boolean)
			.join("\n");
	return "";
}

function oneLine(text: string): string {
	return text.replace(/\s+/gu, " ").trim();
}

function clipText(text: string, budget: number): string {
	const single = oneLine(text);
	return single.length > budget ? `${single.slice(0, budget)}…` : single;
}
