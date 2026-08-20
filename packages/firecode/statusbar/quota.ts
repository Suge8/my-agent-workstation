/**
 * 订阅额度抓取：事件驱动（会话启动、切模型、每轮结束），无定时轮询。
 * 新鲜度与失败退避都落在跨进程缓存里，多个 pi 会话共享同一次请求。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QuotaCache } from "./quota-cache.js";
import {
	type QuotaStatus,
	type QuotaWindow,
	epochMillis,
	parseAnthropicQuota,
	parseGrokQuota,
	parseOpenAIQuota,
	record,
} from "./quota-parse.js";

// 供应商自家 CLI 使用的只读接口，schema 不是公开契约。
const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";
const FRESH_MS = 60_000;
const REQUEST_TIMEOUT_MS = 3_000;
/** 连续失败的退避档位，末档为上限 */
const BACKOFF_MS = [60_000, 120_000, 300_000];

function decodeJwtPayload(token: string): ReturnType<typeof record> {
	const payload = token.split(".")[1];
	if (!payload) return undefined;
	try {
		return record(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
	} catch {
		return undefined;
	}
}

function openAIAccountId(token: string): string | undefined {
	const claims = record(decodeJwtPayload(token)?.["https://api.openai.com/auth"]);
	return typeof claims?.chatgpt_account_id === "string" ? claims.chatgpt_account_id : undefined;
}

function grokCliToken(): string | undefined {
	// Grok billing 拒绝 pi 的 OAuth token，只认官方 CLI 登录态。
	const path = join(homedir(), ".grok", "auth.json");
	if (!existsSync(path)) return undefined;
	try {
		const auth = record(JSON.parse(readFileSync(path, "utf8")));
		for (const [scope, value] of Object.entries(auth ?? {})) {
			if (!scope.startsWith("https://auth.x.ai::")) continue;
			const credential = record(value);
			const token = credential?.key;
			const expiresAt = epochMillis(credential?.expires_at);
			if (typeof token === "string" && token.length > 0 && (!expiresAt || expiresAt > Date.now()))
				return token;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
	const response = await fetch(url, {
		headers,
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`Quota request failed: ${response.status}`);
	return response.json();
}

type QuotaRequest =
	| { provider: "openai-codex" | "anthropic"; token: Promise<string | undefined> }
	| { provider: "xai"; token: string | undefined };

type QuotaProvider = QuotaRequest["provider"];

async function loadQuota(request: QuotaRequest): Promise<QuotaWindow[]> {
	if (request.provider === "openai-codex") {
		const token = await request.token;
		if (!token) return [];
		const accountId = openAIAccountId(token);
		return parseOpenAIQuota(
			await fetchJson(OPENAI_USAGE_URL, {
				Authorization: `Bearer ${token}`,
				...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
				Accept: "application/json",
			}),
		);
	}
	if (request.provider === "anthropic") {
		const token = await request.token;
		if (!token) return [];
		return parseAnthropicQuota(
			await fetchJson(ANTHROPIC_USAGE_URL, {
				Authorization: `Bearer ${token}`,
				"anthropic-beta": "oauth-2025-04-20",
				Accept: "application/json",
			}),
		);
	}
	const { token } = request;
	if (!token) return [];
	const headers = {
		Authorization: `Bearer ${token}`,
		"x-xai-token-auth": "xai-grok-cli",
		Accept: "application/json",
	};
	const [monthly, weekly] = await Promise.allSettled([
		fetchJson(GROK_BILLING_URL, headers),
		fetchJson(`${GROK_BILLING_URL}?format=credits`, headers),
	]);
	if (monthly.status === "rejected" && weekly.status === "rejected") throw monthly.reason;
	return parseGrokQuota(
		monthly.status === "fulfilled" ? monthly.value : undefined,
		weekly.status === "fulfilled" ? weekly.value : undefined,
	);
}

const isQuotaProvider = (provider: string | undefined): provider is QuotaProvider =>
	provider === "openai-codex" || provider === "anthropic" || provider === "xai";

/** 只有订阅制（OAuth 登录）的供应商才有额度可查。 */
function subscriptionProvider(ctx: ExtensionContext): QuotaProvider | undefined {
	const model = ctx.model;
	const provider = model?.provider;
	if (!isQuotaProvider(provider)) return undefined;
	if (
		(provider === "anthropic" || provider === "xai") &&
		(!model || !ctx.modelRegistry.isUsingOAuth(model))
	)
		return undefined;
	return provider;
}

function quotaRequest(ctx: ExtensionContext, provider: QuotaProvider): QuotaRequest {
	if (provider === "xai") return { provider, token: grokCliToken() };
	return { provider, token: ctx.modelRegistry.getApiKeyForProvider(provider) };
}

const statusOf = (windows: QuotaWindow[]): QuotaStatus =>
	windows.length ? { state: "ready", windows } : { state: "unavailable" };

export function registerQuota(
	pi: ExtensionAPI,
	update: (status?: QuotaStatus) => void,
	cache: QuotaCache,
) {
	let requestGeneration = 0;

	const refresh = (ctx: ExtensionContext, force = false) => {
		const provider = subscriptionProvider(ctx);
		if (!provider) {
			requestGeneration++;
			update();
			return;
		}

		const now = Date.now();
		const cached = cache.read(provider);
		if (cached && now < cached.nextAttemptAt) {
			requestGeneration++;
			update(statusOf(cached.windows));
			return;
		}
		if (force) update({ state: "loading" });

		const generation = ++requestGeneration;
		// 先占住退避窗口，避免同一进程内并发请求叠加。
		cache.write(provider, {
			windows: cached?.windows ?? [],
			nextAttemptAt: now + FRESH_MS,
			failures: cached?.failures ?? 0,
		});
		void loadQuota(quotaRequest(ctx, provider))
			.then((windows) => {
				cache.write(provider, {
					windows,
					nextAttemptAt: Date.now() + FRESH_MS,
					failures: 0,
				});
				if (generation === requestGeneration) update(statusOf(windows));
			})
			.catch(() => {
				const failures = (cached?.failures ?? 0) + 1;
				cache.write(provider, {
					windows: [],
					nextAttemptAt: Date.now() + BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1],
					failures,
				});
				if (generation === requestGeneration) update({ state: "unavailable" });
			});
	};

	pi.on("session_start", (_event, ctx) => refresh(ctx, true));
	pi.on("model_select", (_event, ctx) => refresh(ctx, true));
	pi.on("agent_end", (_event, ctx) => refresh(ctx));
	pi.on("session_shutdown", () => {
		requestGeneration++;
		update();
	});
}
