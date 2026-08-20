import { expect, test } from "bun:test";
import {
	NATIVE_COMPACTION_STRATEGY,
	isNativeCompactionDetails,
	resolveLatestNativeCompaction,
} from "./native-details";

test("recognizes a native compaction checkpoint", () => {
	const details = {
		strategy: NATIVE_COMPACTION_STRATEGY,
		provider: "openai-codex",
		api: "openai-codex-responses",
		model: "gpt-5.6-sol",
		baseUrl: "https://chatgpt.com/backend-api",
		compactedWindow: [{ type: "compaction", encrypted_content: "opaque" }],
		createdAt: "2026-07-12T00:00:00.000Z",
	};
	const entry = {
		type: "compaction",
		id: "compact_existing",
		timestamp: "2026-07-12T00:00:00.000Z",
		summary: "[OpenAI native compaction checkpoint]",
		firstKeptEntryId: "entry_1",
		tokensBefore: 512,
		details,
	};

	expect(isNativeCompactionDetails(details)).toBe(true);
	expect(
		resolveLatestNativeCompaction([entry] as never, {
			provider: "openai-codex",
			api: "openai-codex-responses",
			model: "gpt-5.6-sol",
			baseUrl: "https://chatgpt.com/backend-api",
		}),
	).toMatchObject({ ok: true, entry: { id: "compact_existing" } });
});

test("rejects an invalid persisted compacted window", () => {
	expect(
		isNativeCompactionDetails({
			strategy: NATIVE_COMPACTION_STRATEGY,
			provider: "openai",
			api: "openai-responses",
			model: "gpt-5.6-sol",
			baseUrl: "https://api.openai.com/v1",
			compactedWindow: ["not an OpenAI Responses item"],
			createdAt: "2026-07-12T00:00:00.000Z",
		}),
	).toBe(false);
});
