/**
 * 观察会话：进程内 memory 子会话 + 只读工具 + 唯一自定义工具 advise。
 * 系统提示以 prompts/watch.zh.md 为唯一事实源（整体替换，不受项目文件改写）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { InProcessSessionPool } from "../master/spawn.js";
import type { ThinkingLevelValue } from "../config.js";

const PROMPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "prompts", "watch.zh.md");
const OBSERVER_TOOLS = ["read", "grep", "find", "ls", "advise"];

export const SEVERITIES = ["nit", "concern", "blocker"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Advice {
	severity: Severity;
	note: string;
}

export interface Observer {
	/** 喂一段增量并等待评估；至多返回一条建议。 */
	evaluate(increment: string): Promise<Advice | undefined>;
	/** 观察会话自身上下文占比（百分数），未知时 undefined。 */
	contextPercent(): number | undefined;
	dispose(): void;
}

export interface ObserverOptions {
	cwd: string;
	model: Model<any>;
	thinking: ThinkingLevelValue;
	pool: InProcessSessionPool;
}

export async function createObserver(options: ObserverOptions): Promise<Observer> {
	let advice: Advice | undefined;
	const spawned = await options.pool.spawn({
		cwd: options.cwd,
		role: "observer",
		model: options.model,
		thinking: options.thinking,
		tools: OBSERVER_TOOLS,
		customTools: [adviseTool(() => advice, (next) => { advice = next; })],
		systemPrompt: { mode: "replace", text: readFileSync(PROMPT_PATH, "utf8") },
		contextFiles: true,
		persistence: { type: "memory" },
	});
	return {
		async evaluate(increment) {
			advice = undefined;
			await spawned.prompt(increment);
			return advice;
		},
		contextPercent: () => spawned.session.getContextUsage?.()?.percent ?? undefined,
		dispose: () => spawned.dispose(),
	};
}

function adviseTool(current: () => Advice | undefined, capture: (advice: Advice) => void) {
	return {
		name: "advise",
		label: "建议",
		description: "向主代理提交一条供权衡的观察建议；每次评估只接受一条，请只提最严重的那一条。",
		parameters: Type.Object({
			note: Type.String({ description: "一句话说清问题与定位。" }),
			severity: StringEnum(SEVERITIES, { description: "nit=顺手记 concern=值得停一下 blocker=再走就出事" }),
		}),
		execute(_id: string, params: Record<string, unknown>) {
			if (current()) throw new Error("本次评估已提交过建议；余下的问题留到下一次评估");
			const note = typeof params.note === "string" ? params.note.trim() : "";
			if (!note) throw new Error("note 不能为空");
			const severity = params.severity;
			if (!SEVERITIES.includes(severity as Severity)) throw new Error(`severity 值无效：${String(severity)}`);
			capture({ note, severity: severity as Severity });
			return { content: [{ type: "text" as const, text: "已记录，本次评估结束。" }] };
		},
	};
}
