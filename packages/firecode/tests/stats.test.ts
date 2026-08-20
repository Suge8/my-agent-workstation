import { afterEach, describe, expect, test } from "bun:test";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader.ts";

afterEach(cleanupFirecodeModules);

const { usageAttribution } = (await loadFirecodeModule("session/stats.ts")) as {
	usageAttribution: (entry: unknown) => unknown;
};

const usage = {
	input: 10,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
};

describe("usageAttribution", () => {
	test("attributes assistant message usage to provider/model", () => {
		expect(
			usageAttribution({
				type: "message",
				message: {
					role: "assistant",
					provider: "openai",
					model: "gpt-5.5",
					usage,
					timestamp: 1_700_000_000_000,
				},
			}),
		).toEqual({
			provider: "openai",
			model: "gpt-5.5",
			usage,
			timestamp: 1_700_000_000_000,
			countRequest: true,
		});
	});

	test("attributes toolResult usage under tools/summaries", () => {
		expect(
			usageAttribution({
				type: "message",
				timestamp: "2026-07-21T00:00:00.000Z",
				message: {
					role: "toolResult",
					usage,
				},
			}),
		).toMatchObject({
			provider: "tools",
			model: "summaries",
			usage,
			countRequest: false,
		});
	});

	test("attributes compaction and branch_summary entry usage", () => {
		expect(
			usageAttribution({
				type: "compaction",
				timestamp: "2026-07-21T00:00:00.000Z",
				usage,
			}),
		).toMatchObject({
			provider: "tools",
			model: "summaries",
			usage,
			countRequest: false,
		});

		expect(
			usageAttribution({
				type: "branch_summary",
				timestamp: "2026-07-21T00:00:00.000Z",
				usage,
			}),
		).toMatchObject({
			provider: "tools",
			model: "summaries",
			countRequest: false,
		});
	});

	test("ignores entries without usage", () => {
		expect(usageAttribution({ type: "message", message: { role: "assistant" } })).toBeUndefined();
		expect(usageAttribution({ type: "compaction" })).toBeUndefined();
		expect(usageAttribution({ type: "message", message: { role: "user" } })).toBeUndefined();
	});
});
