import { describe, expect, test } from "bun:test";
import { quotaColor } from "../theme.js";
import type { QuotaCache, QuotaCacheEntry } from "../statusbar/quota-cache.js";
import {
	parseAnthropicQuota,
	parseGrokQuota,
	parseOpenAIQuota,
} from "../statusbar/quota-parse.js";
import { registerQuota } from "../statusbar/quota.js";

function memoryCache(): QuotaCache {
	const entries = new Map<string, QuotaCacheEntry>();
	return {
		read: (provider) => entries.get(provider),
		write: (provider, entry) => {
			entries.set(provider, entry);
		},
	};
}

describe("subscription quota parsing", () => {
	test("converts OpenAI used percentages to remaining 5h and 7d quota", () => {
		expect(
			parseOpenAIQuota({
				rate_limit: {
					primary_window: {
						used_percent: 74,
						limit_window_seconds: 18_000,
					},
					secondary_window: {
						used_percent: 12,
						limit_window_seconds: 604_800,
					},
				},
			}),
		).toEqual([
			{ label: "5h", remaining: 26 },
			{ label: "7d", remaining: 88 },
		]);
	});

	test("parses Anthropic and rejects malformed windows", () => {
		expect(
			parseAnthropicQuota({
				five_hour: { utilization: 2 },
				seven_day: { utilization: 54 },
			}),
		).toEqual([
			{ label: "5h", remaining: 98 },
			{ label: "7d", remaining: 46 },
		]);
		expect(parseAnthropicQuota({ five_hour: { utilization: "2" } })).toEqual(
			[],
		);
	});

	test("labels Grok weekly and monthly quota as 7d and 30d", () => {
		expect(
			parseGrokQuota(
				{
					config: {
						monthlyLimit: { val: 15_000 },
						used: { val: 6_591 },
					},
				},
				{ config: { creditUsagePercent: 100 } },
			),
		).toEqual([
			{ label: "7d", remaining: 0 },
			{ label: "30d", remaining: 56 },
		]);
	});
});

test("quota refresh does not retain a session context", async () => {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	let resolveToken = (_token: string | undefined) => {};
	const token = new Promise<string | undefined>((resolve) => {
		resolveToken = resolve;
	});
	let active = true;
	const model = { provider: "openai-codex", id: "test" };
	const registry = {
		isUsingOAuth: () => true,
		getApiKeyForProvider: () => token,
	};
	const ctx = {
		get model() {
			if (!active) throw new Error("stale ctx.model");
			return model;
		},
		get modelRegistry() {
			if (!active) throw new Error("stale ctx.modelRegistry");
			return registry;
		},
	};
	const updates: unknown[] = [];
	registerQuota(
		{
			on: (event: string, handler: (event: unknown, ctx: unknown) => void) =>
				handlers.set(event, handler),
		} as never,
		(status) => updates.push(status),
		memoryCache(),
	);
	handlers.get("agent_end")?.({}, ctx);
	active = false;
	resolveToken(undefined);
	await Promise.resolve();
	await Promise.resolve();
	expect(updates).toEqual([{ state: "unavailable" }]);
});

test("warns at 50% remaining and fails at 25%", () => {
	expect(quotaColor(51)).toBe("success");
	expect(quotaColor(50)).toBe("warning");
	expect(quotaColor(26)).toBe("warning");
	expect(quotaColor(25)).toBe("error");
	expect(quotaColor(0)).toBe("error");
});
