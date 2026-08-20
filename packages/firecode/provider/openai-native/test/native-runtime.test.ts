import { describe, expect, test } from "bun:test";
import {
	resolveNativeCompactionRuntime,
	resolveNativeCompactionTarget,
} from "../src/native-runtime";

function createContext(args: {
	provider?: string;
	api?: string;
	id?: string;
	baseUrl?: string;
	getApiKeyAndHeaders?: () => Promise<unknown>;
} = {}) {
	return {
		model: {
			provider: args.provider ?? "openai",
			api: args.api ?? "openai-responses",
			id: args.id ?? "gpt-5.4",
			baseUrl: args.baseUrl ?? "https://example.com/v1",
		},
		modelRegistry: {
			getApiKeyAndHeaders:
				args.getApiKeyAndHeaders ??
				(async () => ({
					ok: true,
					apiKey: "fixture-key",
					headers: { "x-test-request-header": "present" },
				})),
		},
	} as never;
}

describe("native compaction runtime", () => {
	test("resolves a direct OpenAI target without resolving auth", () => {
		const target = resolveNativeCompactionTarget(createContext());

		expect(target).toEqual({
			ok: true,
			target: expect.objectContaining({
				provider: "openai",
				api: "openai-responses",
				model: "gpt-5.4",
				baseUrl: "https://example.com/v1",
				responsesUrl: "https://example.com/v1/responses",
			}),
		});
	});

	test("resolves openai and codex responses URLs from common base shapes", () => {
		expect(
			resolveNativeCompactionTarget(createContext({ baseUrl: "https://api.openai.com/v1" })),
		).toMatchObject({
			ok: true,
			target: { responsesUrl: "https://api.openai.com/v1/responses" },
		});
		expect(
			resolveNativeCompactionTarget(createContext({ baseUrl: "https://api.openai.com/v1/responses" })),
		).toMatchObject({
			ok: true,
			target: { responsesUrl: "https://api.openai.com/v1/responses" },
		});
		expect(
			resolveNativeCompactionTarget(
				createContext({
					provider: "openai-codex",
					api: "openai-codex-responses",
					baseUrl: "https://chatgpt.com/backend-api",
				}),
			),
		).toMatchObject({
			ok: true,
			target: { responsesUrl: "https://chatgpt.com/backend-api/codex/responses" },
		});
		expect(
			resolveNativeCompactionTarget(
				createContext({
					provider: "openai-codex",
					api: "openai-codex-responses",
					baseUrl: "https://chatgpt.com/backend-api/codex",
				}),
			),
		).toMatchObject({
			ok: true,
			target: { responsesUrl: "https://chatgpt.com/backend-api/codex/responses" },
		});
		expect(
			resolveNativeCompactionTarget(
				createContext({
					provider: "openai-codex",
					api: "openai-codex-responses",
					baseUrl: "https://chatgpt.com/backend-api/codex/responses",
				}),
			),
		).toMatchObject({
			ok: true,
			target: { responsesUrl: "https://chatgpt.com/backend-api/codex/responses" },
		});
	});

	test("resolves auth only when a native compact request is about to run", async () => {
		let authCalls = 0;
		const ctx = createContext({
			getApiKeyAndHeaders: async () => {
				authCalls += 1;
				return {
					ok: true,
					apiKey: "fixture-key",
					headers: { "x-test-request-header": "present" },
				};
			},
		});
		const target = resolveNativeCompactionTarget(ctx);
		if (!target.ok) {
			throw new Error("Expected a native compaction target");
		}

		expect(authCalls).toBe(0);
		const runtime = await resolveNativeCompactionRuntime(ctx, target.target);
		expect(authCalls).toBe(1);
		expect(runtime).toEqual({
			ok: true,
			runtime: expect.objectContaining({
				apiKey: "fixture-key",
				headers: { "x-test-request-header": "present" },
			}),
		});
	});

	test("cancels native compaction when direct-provider auth has no API key", async () => {
		const ctx = createContext({
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: undefined }),
		});
		const target = resolveNativeCompactionTarget(ctx);
		if (!target.ok) {
			throw new Error("Expected a native compaction target");
		}

		expect(await resolveNativeCompactionRuntime(ctx, target.target)).toEqual({
			ok: false,
			reason: "missing-api-key",
		});
	});

	test("does not send native compaction to OpenAI-compatible proxies", () => {
		const target = resolveNativeCompactionTarget(
			createContext({
				provider: "custom-litellm",
				baseUrl: "https://api.example.test/v1",
			}),
		);

		expect(target).toEqual({ ok: false, reason: "unsupported-provider" });
	});
});
