/**
 * 会话 token / 成本统计：扫描 sessions 下的 jsonl，按模型汇总后用 Markdown 展示。
 * 源自 pi-token-stats (MIT, https://github.com/reaishijie/pi-token-stats)，已精简。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, Container, Markdown, Text, matchesKey } from "@earendil-works/pi-tui";

const DEFAULT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

type Usage = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { total?: number };
};

export type SessionLine = {
	type?: string;
	timestamp?: string;
	usage?: Usage;
	message?: { role?: string; provider?: string; model?: string; usage?: Usage; timestamp?: number };
};

export type UsageAttribution = {
	provider: string;
	model: string;
	usage: Usage;
	timestamp?: number;
	countRequest: boolean;
};

/** 与 pi 的 usage-totals 对齐：assistant 归模型，工具与压缩归 tools/summaries。 */
export function usageAttribution(entry: SessionLine): UsageAttribution | undefined {
	const at = (fallback?: number) => fallback ?? (entry.timestamp ? Date.parse(entry.timestamp) : undefined);

	if (entry.type === "message" && entry.message?.usage) {
		const { role, provider, model, usage, timestamp } = entry.message;
		if (role === "assistant") {
			return {
				provider: provider ?? "unknown",
				model: model ?? "unknown",
				usage,
				timestamp: at(timestamp),
				countRequest: true,
			};
		}
		if (role === "toolResult") {
			return { provider: "tools", model: "summaries", usage, timestamp: at(timestamp), countRequest: false };
		}
		return undefined;
	}

	if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
		return { provider: "tools", model: "summaries", usage: entry.usage, timestamp: at(), countRequest: false };
	}
	return undefined;
}

type Totals = {
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tokens: number;
	cost: number;
};

const emptyTotals = (): Totals => ({
	requests: 0,
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	tokens: 0,
	cost: 0,
});

function add(target: Totals, usage: Usage, countRequest: boolean): void {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;

	if (countRequest) target.requests += 1;
	target.input += input;
	target.output += output;
	target.cacheRead += cacheRead;
	target.cacheWrite += cacheWrite;
	target.tokens += usage.totalTokens ?? input + output + cacheRead + cacheWrite;
	target.cost += usage.cost?.total ?? 0;
}

function sessionFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];

	const found: string[] = [];
	const pending = [dir];
	while (pending.length > 0) {
		const current = pending.pop() as string;
		let entries: string[];
		try {
			entries = readdirSync(current);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const path = join(current, entry);
			try {
				if (statSync(path).isDirectory()) pending.push(path);
				else if (entry.endsWith(".jsonl")) found.push(path);
			} catch {
				// 会话文件可能在扫描过程中被轮转掉。
			}
		}
	}
	return found;
}

type Report = {
	days: number;
	from?: number;
	to: number;
	dir: string;
	scanned: number;
	matched: number;
	overall: Totals;
	byModel: Map<string, Totals>;
};

function collect(days: number): Report {
	const to = Date.now();
	const from = days === 0 ? undefined : to - days * DAY_MS;
	const dir = join(getAgentDir(), "sessions");
	const files = sessionFiles(dir);
	const report: Report = {
		days,
		from,
		to,
		dir,
		scanned: files.length,
		matched: 0,
		overall: emptyTotals(),
		byModel: new Map(),
	};

	for (const file of files) {
		let content: string;
		try {
			content = readFileSync(file, "utf8");
		} catch {
			continue;
		}

		let matched = false;
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;

			let attributed: UsageAttribution | undefined;
			try {
				attributed = usageAttribution(JSON.parse(line) as SessionLine);
			} catch {
				continue;
			}
			if (!attributed) continue;
			if (from !== undefined && attributed.timestamp !== undefined && attributed.timestamp < from) continue;

			const key = `${attributed.provider}/${attributed.model}`;
			let model = report.byModel.get(key);
			if (!model) {
				model = emptyTotals();
				report.byModel.set(key, model);
			}
			add(report.overall, attributed.usage, attributed.countRequest);
			add(model, attributed.usage, attributed.countRequest);
			matched = true;
		}

		if (matched) report.matched += 1;
	}

	return report;
}

const number = (value: number): string => new Intl.NumberFormat("en-US").format(Math.round(value));

const compactTokens = (value: number): string => {
	const rounded = Math.round(value);
	if (rounded >= 100_000_000) return `${(rounded / 100_000_000).toFixed(1)}亿`;
	if (rounded >= 10_000) return `${(rounded / 10_000).toFixed(1)}万`;
	return number(rounded);
};

const cost = (value: number): string => `$${value.toFixed(value >= 1 ? 2 : 4)}`;

const dateTime = (value: number): string => {
	const date = new Date(value);
	const pad = (part: number) => part.toString().padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const row = (cells: Array<string | number>): string => `| ${cells.join(" | ")} |`;

const totalsCells = (totals: Totals): string[] => [
	number(totals.input),
	number(totals.output),
	number(totals.cacheRead),
	number(totals.cacheWrite),
	compactTokens(totals.tokens),
	cost(totals.cost),
];

function buildMarkdown(report: Report): string {
	const range =
		report.days === 0
			? "全部"
			: `最近 ${report.days} 天（${dateTime(report.from as number)} ~ ${dateTime(report.to)}）`;
	const headers = ["输入", "输出", "缓存读", "缓存写", "总 Token", "成本"];
	const aligns = headers.map(() => "---:");
	const lines = [
		"# Token 用量",
		"",
		`- 范围：${range}`,
		`- 会话：命中 ${number(report.matched)} / 扫描 ${number(report.scanned)} 个文件`,
		`- 请求：${number(report.overall.requests)} 次，合计 ${cost(report.overall.cost)}`,
		"",
		row(headers),
		row(aligns),
		row(totalsCells(report.overall)),
		"",
		"## 按模型",
		"",
	];

	const models = [...report.byModel.entries()].sort((left, right) => right[1].tokens - left[1].tokens);
	if (models.length === 0) {
		lines.push("该范围内没有用量记录。");
		return lines.join("\n");
	}

	lines.push(row(["模型", "请求", ...headers]));
	lines.push(row(["---", "---:", ...aligns]));
	for (const [key, totals] of models) {
		lines.push(row([`\`${key}\``, number(totals.requests), ...totalsCells(totals)]));
	}
	return lines.join("\n");
}

async function show(markdown: string, ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") {
		console.log(markdown);
		return;
	}

	await ctx.ui.custom((_tui, theme, _keybindings, done) => {
		const container = new Container();
		const border = new DynamicBorder((text: string) => theme.fg("accent", text));
		container.addChild(border);
		container.addChild(new Markdown(markdown, 1, 1, getMarkdownTheme()));
		container.addChild(new Text(theme.fg("dim", "Enter / Esc 关闭"), 1, 0));
		container.addChild(border);

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "enter") || matchesKey(data, "escape")) done(undefined);
			},
		};
	});
}

/** 支持 `/tokens 7`、`/tokens --days 7`、`/tokens 0`（全部）。 */
export function parseDays(args: string | undefined): number {
	const text = (args ?? "").trim();
	if (!text) return DEFAULT_DAYS;

	const matched = text.match(/(?:^|\s)(?:--days|-d)\s+(\d+)(?:\s|$)/i) ?? text.match(/^(\d+)\s*d?$/i);
	const value = Number.parseInt(matched?.[1] ?? "", 10);
	return Number.isFinite(value) ? value : DEFAULT_DAYS;
}

const dayCompletions: AutocompleteItem[] = [
	{ value: "7", label: "7", description: "最近 7 天" },
	{ value: "30", label: "30", description: "最近 30 天（默认）" },
	{ value: "0", label: "0", description: "全部历史" },
];

export function registerStats(pi: ExtensionAPI): void {
	pi.registerCommand("tokens", {
		description: "统计会话 token 与成本，参数为天数：默认 30，0 表示全部",
		getArgumentCompletions: (prefix: string) => {
			const matches = dayCompletions.filter((item) => item.value.startsWith(prefix.trim()));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args: string | undefined, ctx: ExtensionCommandContext) => {
			const days = parseDays(args);
			if (ctx.hasUI) {
				ctx.ui.notify(`统计中（${days === 0 ? "全部历史" : `最近 ${days} 天`}）…`, "info");
			}
			await show(buildMarkdown(collect(days)), ctx);
		},
	});
}
