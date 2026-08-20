/**
 * Master 事件文本与紧凑行的共享格式契约（纯函数、零宿主依赖，可被测试直接导入）。
 * 分节标记是 herdr 产文与紧凑卡提取的单一事实源：改词两侧编译期同步，杜绝静默退化
 * （曾经的隐式跨文件耦合让"改文案→预览悄悄消失"且测试全绿）。
 */
export const MASTER_EVENT_TYPE = "firecode-master-event";

/** 正文分节标记：herdr 产文用它拼标记行，紧凑行提取用它识别正文首句。 */
export const BODY_SECTIONS = {
	reply: "回复",
	error: "错误",
	question: "问题",
	finalReply: "最终回复",
	lastOutput: "中断前最后输出",
} as const;

/** 产文侧唯一入口：正文段一律以 `<标记>：` 独占一行开头。 */
export function sectionLine(section: keyof typeof BODY_SECTIONS): string {
	return `${BODY_SECTIONS[section]}：`;
}

const BODY_MARKER = new RegExp(`^(?:${Object.values(BODY_SECTIONS).join("|")})：$`, "u");

const VERSION = 1;

export interface MasterEventDetails {
	version: typeof VERSION;
	titles: string[];
}

/** 每个事件一行：首行标题句 + 正文首句预览（渲染时按宽度截断）。 */
export function masterEventDetails(contents: string[]): MasterEventDetails {
	return { version: VERSION, titles: contents.map(compactLine) };
}

function compactLine(content: string): string {
	const lines = content.split("\n");
	const title = lines[0] ?? "";
	const marker = lines.findIndex((line) => BODY_MARKER.test(line.trim()));
	if (marker < 0) return title;
	const preview = lines.slice(marker + 1).find((line) => line.trim());
	return preview ? `${title} — ${preview.trim()}` : title;
}

export function isValidMasterEventDetails(value: unknown): value is MasterEventDetails {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== 2 || record.version !== VERSION) return false;
	return Array.isArray(record.titles) &&
		record.titles.length > 0 &&
		record.titles.every((title) => typeof title === "string");
}
