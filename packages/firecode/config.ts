/** FireCode 配置：只读 Pi Agent 目录下的 `extensions/firecode/config.jsonc`。 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseJsonc } from "./jsonc.js";

export type Language = "zh" | "en";
export type ThinkingLevelValue =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

export interface Preset {
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevelValue;
	tools?: string[];
	instructions?: string;
	/** 一键切换，如 alt+1；不填则无快捷键 */
	key?: string;
}

export interface ReviewModel {
	model: string;
	thinking: ThinkingLevelValue;
}

/** /fire-review 配置：审查者 / 顾问模型 + 循环限制。见 config.jsonc 的 review 节注释。 */
export interface ReviewConfig {
	advisor: ReviewModel;
	reviewers: ReviewModel[];
	/** 审查轮数硬上限。 */
	maxRounds: number;
	/** 连续几轮失败触发顾问仲裁。 */
	advisorAfterFailures: number;
	/** 单个审查者 / 顾问子进程超时（分钟）。 */
	timeoutMinutes: number;
	/** 审查者只读工具白名单。 */
	tools: string[];
	background: { command: string };
	language: Language;
}

/** Master 选型表条目：注入 subagents 工具提示词，供派发时选型。 */
export interface MasterModel {
	/** 真实模型 id：provider/model。 */
	model: string;
	thinking: ThinkingLevelValue;
	/** 适用场景。 */
	use: string;
}

export interface MasterConfig {
	models: MasterModel[];
}

export const DEFAULT_MASTER_MODELS: MasterModel[] = [
	{ model: "openai-codex/gpt-5.6-sol", thinking: "medium", use: "调研与实现/调试，调研完就在原 Worker 会话继续实现" },
	{ model: "openai-codex/gpt-5.6-luna", thinking: "medium", use: "大规模并行快任务：整库扫冗余、批量审查、跨语言迁移，成批开多个" },
	{ model: "anthropic/claude-fable-5", thinking: "medium", use: "架构" },
	{ model: "kimi-coding/k3-256k", thinking: "medium", use: "设计师" },
];

export const FEATURES = [
	"header",
	"statusbar",
	"tools",
	"presets",
	"rename",
	"stats",
	"claudeSub",
	"openaiNative",
	"workingFlame",
	"bark",
	"review",
	"master",
] as const;

export type Feature = (typeof FEATURES)[number];

export const DEFAULT_KEYS = {
	rename: "ctrl+r",
	cyclePreset: "ctrl+shift+u",
	fast: "ctrl+f",
} as const;

export type FireCodeKeys = {
	rename: string;
	cyclePreset: string;
	fast: string;
};

export interface FireCodeConfig {
	features: Partial<Record<Feature, boolean>>;
	keys: FireCodeKeys;
	presets: Record<string, Preset>;
	review: ReviewConfig;
	master: MasterConfig;
}

export type LoadedConfig = {
	config: FireCodeConfig;
	problems: string[];
};

export const CONFIG_PATH = join(getAgentDir(), "extensions", "firecode", "config.jsonc");

function readFile(problems: string[]): Record<string, unknown> {
	if (!existsSync(CONFIG_PATH)) {
		problems.push("config.jsonc 不存在，已关闭可选功能");
		return { features: Object.fromEntries(FEATURES.map((feature) => [feature, false])) };
	}
	try {
		const parsed: unknown = parseJsonc(readFileSync(CONFIG_PATH, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			problems.push("config.jsonc 顶层必须是对象");
			return {};
		}
		return parsed as Record<string, unknown>;
	} catch (error) {
		// 统一前缀：文件级故障必须能被调用方识别并阻断功能，
		// 不能因为消息文本不带节名就被当成无关问题过滤掉。
		const message = error instanceof Error ? error.message : String(error);
		problems.push(`config.jsonc 解析失败：${message}`);
		return {};
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function checkFeatures(features: Record<string, unknown>, problems: string[]): void {
	for (const [key, value] of Object.entries(features)) {
		if (!FEATURES.includes(key as Feature)) {
			problems.push(`未知开关 features.${key}，可用：${FEATURES.join(" / ")}`);
			continue;
		}
		// 开关只能是布尔：写成字符串 "false" 时因为 `!== false` 仍会启用，
		// 而启用 review 意味着真实的模型调用，不能静默放行。
		if (typeof value !== "boolean")
			problems.push(`features.${key} 必须是 true 或 false`);
	}
}

function checkKeys(keys: FireCodeKeys, presets: Record<string, Preset>, problems: string[]): void {
	const owners = new Map<string, string>([
		[keys.rename, "keys.rename"],
		[keys.cyclePreset, "keys.cyclePreset"],
		[keys.fast, "keys.fast"],
	]);
	const declared = Object.entries(keys);
	for (let index = 0; index < declared.length; index++) {
		for (let other = index + 1; other < declared.length; other++) {
			if (declared[index][1] === declared[other][1]) {
				problems.push(
					`快捷键 ${declared[index][1]} 被 keys.${declared[index][0]} 和 keys.${declared[other][0]} 重复占用`,
				);
			}
		}
	}
	for (const [name, preset] of Object.entries(presets)) {
		if (!preset?.key) continue;
		const owner = owners.get(preset.key);
		if (owner) problems.push(`快捷键 ${preset.key} 被 ${owner} 和预设 ${name} 重复占用`);
		else owners.set(preset.key, `预设 ${name}`);
	}
}

let cached: LoadedConfig | undefined;

export function loadConfig(): LoadedConfig {
	if (cached) return cached;

	const problems: string[] = [];
	const raw = readFile(problems);
	// features 省略表示沿用默认全开；只要显式写了，就必须是对象。
	// 非对象不能回退成 {}，因为 {} 在入口语义里正是「全部启用」。
	const invalidFeatures = raw.features !== undefined && !isPlainObject(raw.features);
	if (invalidFeatures) problems.push("features 必须是对象");
	const features: Partial<Record<Feature, boolean>> = invalidFeatures
		? Object.fromEntries(FEATURES.map((feature) => [feature, false]))
		: asRecord(raw.features);
	const rawKeys = asRecord(raw.keys);
	const presets = asRecord(raw.presets) as Record<string, Preset>;
	const keys: FireCodeKeys = {
		rename: typeof rawKeys.rename === "string" ? rawKeys.rename : DEFAULT_KEYS.rename,
		cyclePreset:
			typeof rawKeys.cyclePreset === "string" ? rawKeys.cyclePreset : DEFAULT_KEYS.cyclePreset,
		fast: typeof rawKeys.fast === "string" ? rawKeys.fast : DEFAULT_KEYS.fast,
	};
	checkFeatures(features, problems);
	checkKeys(keys, presets, problems);
	// review 写成字符串/数组/null 时不能静默当空对象：那会拿默认模型真实发起审查。
	if (raw.review !== undefined && !isPlainObject(raw.review))
		problems.push("review 必须是对象");
	const review = parseReviewConfig(asRecord(raw.review), problems);
	// master 同理：花名册错误会拿错模型真实发起 Worker，不能静默当空对象。
	if (raw.master !== undefined && !isPlainObject(raw.master))
		problems.push("master 必须是对象");
	const master = parseMasterConfig(asRecord(raw.master), problems);

	cached = { config: { features, keys, presets, review, master }, problems };
	return cached;
}

// ---- review 节 ----

const REVIEW_KEYS = new Set([
	"advisor",
	"reviewers",
	"maxRounds",
	"advisorAfterFailures",
	"timeoutMinutes",
	"tools",
	"background",
	"language",
]);
const DEFAULT_TOOLS = ["read", "grep", "find", "ls", "bash"];
const DEFAULT_ADVISOR: ReviewModel = { model: "kimi-coding/k3-256k", thinking: "max" };
const DEFAULT_REVIEWERS: ReviewModel[] = [
	{ model: "anthropic/claude-opus-5", thinking: "high" },
	{ model: "anthropic/claude-sonnet-5", thinking: "high" },
	{ model: "anthropic/claude-fable-5", thinking: "high" },
];
const THINKING_LEVELS = new Set<ThinkingLevelValue>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);
const LANGUAGES = new Set<Language>(["zh", "en"]);

/** 导出供测试：严格拒绝未知字段（含嵌套），类型错误一律记录而非静默回退。 */
export function parseReviewConfig(raw: Record<string, unknown>, problems: string[]): ReviewConfig {
	for (const key of Object.keys(raw))
		if (!REVIEW_KEYS.has(key)) problems.push(`未知字段 review.${key}`);
	const advisor = reviewModel(raw.advisor, "review.advisor", DEFAULT_ADVISOR, problems);
	const reviewers = reviewModels(raw.reviewers, problems);
	return {
		advisor,
		reviewers,
		maxRounds: reviewInt(raw.maxRounds, "review.maxRounds", 5, 1, 10, problems),
		advisorAfterFailures: reviewInt(raw.advisorAfterFailures, "review.advisorAfterFailures", 2, 1, 5, problems),
		timeoutMinutes: reviewInt(raw.timeoutMinutes, "review.timeoutMinutes", 20, 1, 60, problems),
		tools: reviewTools(raw.tools, problems),
		background: { command: reviewBackground(raw.background, problems) },
		language: reviewLanguage(raw.language, problems),
	};
}

/** 嵌套对象也做键白名单：拼写错误必须报出来，不能静默回退默认值。 */
function rejectUnknownKeys(
	record: Record<string, unknown>,
	allowed: readonly string[],
	field: string,
	problems: string[],
) {
	for (const key of Object.keys(record))
		if (!allowed.includes(key)) problems.push(`未知字段 ${field}.${key}`);
}

function reviewModel(
	value: unknown,
	field: string,
	fallback: ReviewModel,
	problems: string[],
): ReviewModel {
	if (value === undefined) return fallback;
	const record = asRecord(value);
	rejectUnknownKeys(record, ["model", "thinking"], field, problems);
	if (!record.model || typeof record.model !== "string") {
		problems.push(`${field}.model 必须是非空字符串`);
		return fallback;
	}
	const thinking =
		typeof record.thinking === "string" && THINKING_LEVELS.has(record.thinking as ThinkingLevelValue)
			? (record.thinking as ThinkingLevelValue)
			: fallback.thinking;
	if (thinking !== record.thinking) problems.push(`${field}.thinking 值无效`);
	return { model: record.model, thinking };
}

function reviewModels(value: unknown, problems: string[]): ReviewModel[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 5) {
		if (value !== undefined) problems.push("review.reviewers 必须包含 1–5 个模型");
		return [...DEFAULT_REVIEWERS];
	}
	return value.map((item, index) =>
		reviewModel(item, `review.reviewers[${index}]`, DEFAULT_REVIEWERS[index] ?? DEFAULT_REVIEWERS[0], problems),
	);
}

function reviewInt(
	value: unknown,
	field: string,
	fallback: number,
	min: number,
	max: number,
	problems: string[],
): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
		problems.push(`${field} 必须是 ${min}–${max} 的整数`);
		return fallback;
	}
	return value;
}

function reviewTools(value: unknown, problems: string[]): string[] {
	if (value === undefined) return [...DEFAULT_TOOLS];
	if (!Array.isArray(value)) {
		problems.push("review.tools 必须是字符串数组");
		return [...DEFAULT_TOOLS];
	}
	const tools = value.filter((item): item is string => typeof item === "string" && item.length > 0);
	if (tools.length !== value.length) problems.push("review.tools 必须是字符串数组");
	return tools.length > 0 ? tools : [...DEFAULT_TOOLS];
}

function reviewBackground(value: unknown, problems: string[]): string {
	if (value === undefined) return "pi";
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		problems.push("review.background 必须是对象");
		return "pi";
	}
	const record = asRecord(value);
	rejectUnknownKeys(record, ["command"], "review.background", problems);
	const command = record.command;
	if (command !== undefined && (typeof command !== "string" || command.length === 0)) {
		problems.push("review.background.command 必须是非空字符串");
		return "pi";
	}
	return typeof command === "string" ? command : "pi";
}

// ---- master 节 ----

/** 导出供测试：与 review 节同样严格拒绝未知字段，类型错误记录而非静默回退。 */
export function parseMasterConfig(raw: Record<string, unknown>, problems: string[]): MasterConfig {
	for (const key of Object.keys(raw))
		if (key !== "models") problems.push(`未知字段 master.${key}`);
	if (raw.models === undefined) return { models: [...DEFAULT_MASTER_MODELS] };
	if (!Array.isArray(raw.models) || raw.models.length === 0 || raw.models.length > 8) {
		problems.push("master.models 必须包含 1–8 个模型");
		return { models: [...DEFAULT_MASTER_MODELS] };
	}
	const models = raw.models.map((item, index) => masterModel(item, `master.models[${index}]`, problems));
	if (new Set(models.map((entry) => entry.model)).size !== models.length)
		problems.push("master.models 模型不能重复");
	return { models };
}

function masterModel(value: unknown, field: string, problems: string[]): MasterModel {
	const record = asRecord(value);
	rejectUnknownKeys(record, ["model", "thinking", "use"], field, problems);
	const model = typeof record.model === "string" && record.model ? record.model : "";
	if (!model) problems.push(`${field}.model 必须是非空字符串`);
	let thinking: ThinkingLevelValue = "medium";
	if (record.thinking !== undefined) {
		if (typeof record.thinking === "string" && THINKING_LEVELS.has(record.thinking as ThinkingLevelValue))
			thinking = record.thinking as ThinkingLevelValue;
		else problems.push(`${field}.thinking 值无效`);
	}
	let use = "通用";
	if (record.use !== undefined) {
		if (typeof record.use === "string" && record.use) use = record.use;
		else problems.push(`${field}.use 必须是非空字符串`);
	}
	return { model, thinking, use };
}

function reviewLanguage(value: unknown, problems: string[]): Language {
	if (value === undefined) return "zh";
	if (typeof value !== "string" || !LANGUAGES.has(value as Language)) {
		problems.push("review.language 必须是 zh 或 en");
		return "zh";
	}
	return value as Language;
}
