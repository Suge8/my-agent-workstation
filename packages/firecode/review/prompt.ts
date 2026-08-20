/**
 * Prompt 组装：纯函数拼装审查 / 顾问 / 修复反馈文本。
 * 模板文件读取是唯一 IO（readPrompt），拼装本身零副作用可单测。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Language } from "../config.js";
import type { AdvisorResult, ReviewState, SummaryKind } from "./state.js";

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts");

export type PromptKind = "review" | "advisor";

export function readPrompt(kind: PromptKind, language: Language): string {
	const path = join(PROMPTS_DIR, `${kind}.${language}.md`);
	if (!existsSync(path)) return "";
	return readFileSync(path, "utf8");
}

export interface ReviewPromptInput {
	language: Language;
	scope: string;
	focus: string;
	evidence: string;
	history: ReviewState["history"];
	round: number;
}

export function buildReviewPrompt(template: string, input: ReviewPromptInput): string {
	const sep = input.language === "en" ? ":" : "：";
	const parts = [
		template,
		`${input.language === "en" ? "Review target" : "审查对象"}${sep}\n${input.scope}`,
	];
	if (input.focus)
		parts.push(`${input.language === "en" ? "Focus" : "关注点"}${sep}\n${input.focus}`);
	const prior = priorRoundsSection(input.history, input.round, input.language);
	if (prior) parts.push(prior);
	parts.push(`${input.language === "en" ? "Session evidence" : "会话证据"}${sep}\n${input.evidence}`);
	return parts.filter((part) => part !== "").join("\n\n");
}

/** 往轮 FAIL 发现清单（两相收敛的闭环输入）：第 2 轮起注入。 */
export function priorRoundsSection(
	history: ReviewState["history"],
	round: number,
	language: Language,
): string | undefined {
	const prior = history.filter((entry) => entry.round < round && entry.result === "failed");
	if (round <= 1 || prior.length === 0) return undefined;
	const header =
		language === "en"
			? `Prior round findings (newest first)${language === "en" ? "" : "："}`
			: "往轮发现清单（由新到旧）：";
	const body = prior
		.map((entry) => {
			const label =
				language === "en" ? `## Round ${entry.round} · failed` : `## 第 ${entry.round} 轮 · 未通过`;
			// 顾问裁决必须随轮注入：否则被顾问排除的发现会在后续轮被审查者原样重提，循环无法收敛。
			const advisor = entry.advisor
				? `\n\n### ${language === "en" ? "Advisor ruling" : "顾问裁决"}（${entry.advisor.verdict}）\n${entry.advisor.advice}`
				: "";
			return `${label}\n${entry.details}${advisor}`;
		})
		.join("\n\n");
	return `${header}\n${body}`;
}

export interface AdvisorPromptInput {
	language: Language;
	focus: string;
	details: string;
	history: ReviewState["history"];
	round: number;
}

export function buildAdvisorPrompt(template: string, input: AdvisorPromptInput): string {
	const sep = input.language === "en" ? ":" : "：";
	const parts = [template];
	if (input.focus)
		parts.push(`${input.language === "en" ? "Review focus" : "审查关注点"}${sep}\n${input.focus}`);
	parts.push(
		`${input.language === "en" ? "This round FAIL findings" : "本轮 FAIL 发现"}${sep}\n${input.details}`,
	);
	const prior = priorRoundsSection(input.history, input.round, input.language);
	if (prior) parts.push(`${input.language === "en" ? "Prior FAIL history" : "往轮 FAIL 历史"}${sep}\n${prior}`);
	return parts.join("\n\n");
}

export interface FixFeedbackInput {
	language: Language;
	details: string;
	advisor: AdvisorResult | null;
}

/** 投递给执行模型的修复反馈：把审查发现当假设核实，修根因不压表象。 */
export function buildFixFeedback(input: FixFeedbackInput): string {
	// narrow 与 continue 必须产生可区分的行为：narrow 不再要求逐条修全部发现，
	// 而是把顾问给的范围当约束，只修真正阻塞当前需求的那部分。
	const narrowed = input.advisor?.verdict === "narrow";
	const parts = [narrowInstruction(input.language, narrowed), "", input.details];
	if (input.advisor?.advice) {
		const label =
			input.language === "en"
				? narrowed
					? "Advisor scope (authoritative)"
					: "Advisor note"
				: narrowed
					? "顾问收窄后的范围（以此为准）"
					: "顾问建议";
		parts.push("", `${label}${input.language === "en" ? ":" : "："}`, input.advisor.advice);
	}
	return parts.join("\n");
}

function narrowInstruction(language: Language, narrowed: boolean) {
	if (!narrowed) return language === "en" ? FIX_INSTRUCTION_EN : FIX_INSTRUCTION_ZH;
	return language === "en" ? NARROW_INSTRUCTION_EN : NARROW_INSTRUCTION_ZH;
}

const FIX_INSTRUCTION_ZH =
	"本轮审查未通过，请修复以下发现。将审查反馈视为待核实假设，而非事实：先基于当前文件、测试/检查输出和会话约束核实。反馈属实时，逐条修复全部属实发现，修根因而非表象，同一根因的其他出现点一并修复，修完端到端验证问题已彻底解决后直接结束（本回合结束后会自动进入下一轮复审）；避免无关重构、抽象、依赖或风格改动。反馈不成立时，不应用该反馈，并说明依据（文件、命令输出或约束）。";

const NARROW_INSTRUCTION_ZH =
	"本轮审查未通过，但顾问判定发现清单范围过宽。下方是完整发现，仅供参考：只修顾问收窄后的范围内、真正阻塞当前需求的那部分，其余发现不要处理。先根据当前文件与命令输出核实再修，修根因不压表象，修复验证后直接结束（本回合结束后会自动进入下一轮复审）；避免无关重构、抽象、依赖或风格改动。若认为收窄范围内的发现也不成立，说明依据并停下。";

const NARROW_INSTRUCTION_EN =
	"This round's review failed, but the advisor judged the finding list too broad. The full findings below are context only: fix only the part inside the advisor's narrowed scope that actually blocks the current requirement, and leave the rest alone. Verify against current files and command output before fixing, fix root causes not symptoms, and finish directly after verification (the next review round will start automatically); avoid unrelated refactors, abstractions, dependency or style changes. If even the narrowed findings do not hold, explain why and stop.";

/** 总结提示携带的终态材料上限：模型已经历过修复轮，材料只补它没见过的终态结论。 */
const SUMMARY_MATERIAL_LIMIT = 4_000;

export interface SummaryPromptInput {
	language: Language;
	kind: SummaryKind;
	rounds: number;
	/** 终态材料：通过=末轮审查结论；max_rounds=末轮发现；advisor_stop=顾问裁决。 */
	material: string;
}

/** 质量裁决终态后投给执行模型的总结回合提示：人话收尾，带反循环禁令。 */
export function buildSummaryPrompt(input: SummaryPromptInput): string {
	const material = input.material.length > SUMMARY_MATERIAL_LIMIT
		? `${input.material.slice(0, SUMMARY_MATERIAL_LIMIT)}\n…`
		: input.material;
	const body = summaryInstruction(input.language, input.kind, input.rounds);
	if (!material.trim()) return body;
	return `${body}\n\n${summaryMaterialLabel(input.language, input.kind)}\n${material}`;
}

function summaryMaterialLabel(language: Language, kind: SummaryKind): string {
	if (kind === "advisor_stop") return language === "en" ? "Advisor ruling:" : "顾问裁决：";
	if (kind === "max_rounds") return language === "en" ? "Final round findings:" : "末轮未通过的发现：";
	return language === "en" ? "Final review verdict:" : "末轮审查结论：";
}

function summaryInstruction(language: Language, kind: SummaryKind, rounds: number): string {
	if (language === "en") {
		if (kind === "passed")
			return `The adversarial review passed after ${rounds} round(s). Give the user a concise plain-language wrap-up: 1) what the review rounds found and what you fixed; 2) how it finally passed (key fixes and verification evidence); 3) non-blocking suggestions raised during review — list each and say whether you recommend addressing it and why. Summary only: do not change code or run tools; end this turn with the final reply.`;
		if (kind === "max_rounds")
			return `The adversarial review did not pass within ${rounds} round(s) and stopped at the limit. Summarize honestly for the user in plain language: 1) what each round got stuck on and what fixes you attempted; 2) your root-cause read on why it would not converge; 3) the real current state of the code and remaining risks; 4) what you recommend the user do next. Summary only: do not keep changing code or run tools; end this turn with the final reply.`;
		return `The adversarial review was stopped by the advisor (round ${rounds}). Using the advisor ruling below, summarize for the user: 1) how far the review loop got and what was fixed; 2) why the advisor called it off; 3) the current state and your recommended next step. Summary only: do not change code or run tools; end this turn with the final reply.`;
	}
	if (kind === "passed")
		return `对抗审查已通过（共 ${rounds} 轮）。请给用户一个简洁的人话收尾总结：1) 各轮审查发现了什么、你修了什么；2) 最终靠什么通过（关键修复与验证证据）；3) 审查中提到但未阻塞通过的建议——逐条列出，并给出你建议处理还是不处理及理由。只做总结：不要修改代码、不要运行工具，直接以最终回复结束本回合。`;
	if (kind === "max_rounds")
		return `对抗审查在 ${rounds} 轮内未能通过，已按上限终止。请如实向用户总结（人话）：1) 各轮分别卡在什么发现上、你做了哪些修复尝试；2) 你认为无法收敛的根因；3) 当前代码的真实状态与剩余风险；4) 建议用户下一步怎么办。只做总结：不要再继续修改代码或运行工具，直接以最终回复结束本回合。`;
	return `对抗审查被顾问裁定终止（第 ${rounds} 轮）。请结合下方顾问裁决向用户总结：1) 审查循环走到了哪一步、修了什么；2) 顾问为什么叫停；3) 当前状态与你建议的下一步。只做总结：不要再修改代码或运行工具，直接以最终回复结束本回合。`;
}

const FIX_INSTRUCTION_EN =
	"This round's review failed. Fix the findings below. Treat the review feedback as hypotheses to verify, not facts: verify against current files, test/check output and session constraints. When feedback is valid, fix every valid finding, fixing root causes not symptoms and other occurrences of the same root cause, and verify end-to-end that issues are truly resolved then finish directly (the next review round will start automatically); avoid unrelated refactors, abstractions, dependency or style changes. When feedback is not valid, do not apply it and explain why (files, command output, or constraints).";
