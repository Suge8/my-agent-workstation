import { expect, test } from "bun:test";
import { applyOpenAIOptions, supportsFastMode } from "./options";

const settings = {
	nativeCompaction: true,
	providers: {
		"openai-codex": { textVerbosity: "low" as const, priority: true as const },
		rc: { textVerbosity: "high" as const },
	},
};

const codexModel = {
	provider: "openai-codex",
	api: "openai-codex-responses",
	id: "gpt-5.6-sol",
} as never;

test("preserves the Responses fast-mode capability allowlist", () => {
	for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
		expect(supportsFastMode({ provider: "openai-codex", api: "openai-codex-responses", id } as never)).toBe(true);
	}
	expect(supportsFastMode({ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-4.1" } as never)).toBe(false);
});

test("applies configured Responses options without touching input", () => {
	const payload = {
		model: "gpt-5.6-sol",
		input: [{ role: "user", content: "hello" }],
	};

	const rewritten = applyOpenAIOptions(payload, codexModel, settings, undefined);
	expect(rewritten).toEqual({
		...payload,
		text: { verbosity: "low" },
		service_tier: "priority",
	});
	expect(rewritten.input).toBe(payload.input);
});

test("CLI verbosity overrides config while an invalid override disables only verbosity", () => {
	const payload = { model: "gpt-5.6-sol", input: [] };

	expect(applyOpenAIOptions(payload, codexModel, settings, "high")).toEqual({
		...payload,
		text: { verbosity: "high" },
		service_tier: "priority",
	});
	expect(applyOpenAIOptions(payload, codexModel, settings, "invalid")).toEqual({
		...payload,
		service_tier: "priority",
	});
});

test("keeps an already-correct payload by reference", () => {
	const payload = {
		model: "gpt-5.6-sol",
		input: [],
		text: { verbosity: "low" },
		service_tier: "priority",
	};

	expect(applyOpenAIOptions(payload, codexModel, settings, undefined)).toBe(payload);
});

test("supports Responses options for rc without enabling native compaction there", () => {
	const payload = { model: "gpt-5.5", input: [] };
	const rcModel = {
		provider: "rc",
		api: "openai-responses",
		id: "gpt-5.5",
	} as never;

	expect(applyOpenAIOptions(payload, rcModel, settings, undefined)).toEqual({
		...payload,
		text: { verbosity: "high" },
	});
});

test("applies xAI priority on Completions without OpenAI verbosity", () => {
	const grok = {
		provider: "xai",
		api: "openai-completions",
		id: "grok-4.6",
	} as never;
	const payload = { model: "grok-4.6", messages: [] };
	const grokSettings = {
		nativeCompaction: false,
		providers: { xai: { priority: true as const } },
	};

	expect(supportsFastMode(grok)).toBe(true);
	expect(applyOpenAIOptions(payload, grok, grokSettings, undefined)).toEqual({
		...payload,
		service_tier: "priority",
	});
});
