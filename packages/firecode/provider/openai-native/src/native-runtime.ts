import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const NATIVE_PROVIDERS = new Set(["openai", "openai-codex"]);
const NATIVE_APIS = new Set(["openai-responses", "openai-codex-responses"]);

type NativeCompactionApi = "openai-responses" | "openai-codex-responses";
type RuntimeModel = Model<Api>;

export type ResponsesRequestPayload = {
	model: string;
	input: unknown[];
	instructions?: unknown;
	[key: string]: unknown;
};

export type NativeCompactionTarget = {
	provider: string;
	api: NativeCompactionApi;
	model: string;
	baseUrl: string;
	responsesUrl: string;
	currentModel: RuntimeModel;
	payload?: ResponsesRequestPayload;
};

export type NativeCompactionRuntime = NativeCompactionTarget & {
	apiKey: string;
	headers?: ProviderHeaders;
};

type TargetFailureReason =
	| "missing-model"
	| "unsupported-provider"
	| "unsupported-api"
	| "missing-base-url"
	| "unsupported-payload"
	| "payload-model-mismatch";

export type NativeCompactionTargetResolution =
	| { ok: true; target: NativeCompactionTarget }
	| { ok: false; reason: TargetFailureReason };

export type NativeCompactionRuntimeResolution =
	| { ok: true; runtime: NativeCompactionRuntime }
	| { ok: false; reason: "missing-api-key" | "auth-error" };

function isNativeCompactionApi(value: string): value is NativeCompactionApi {
	return NATIVE_APIS.has(value);
}

function normalizeBaseUrl(baseUrl: string | undefined): string | undefined {
	const normalized = baseUrl?.trim().replace(/\/+$/, "");
	return normalized || undefined;
}

function buildResponsesUrl(baseUrl: string, api: NativeCompactionApi): string {
	if (api === "openai-responses") {
		return baseUrl.endsWith("/responses") ? baseUrl : `${baseUrl}/responses`;
	}
	if (baseUrl.endsWith("/codex/responses")) {
		return baseUrl;
	}
	return baseUrl.endsWith("/codex") ? `${baseUrl}/responses` : `${baseUrl}/codex/responses`;
}

function isResponsesRequestPayload(payload: unknown): payload is ResponsesRequestPayload {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return false;
	}
	const candidate = payload as Record<string, unknown>;
	return typeof candidate.model === "string" && Array.isArray(candidate.input);
}

export function resolveNativeCompactionTarget(
	ctx: ExtensionContext,
	payload?: unknown,
): NativeCompactionTargetResolution {
	const currentModel = ctx.model;
	if (!currentModel) {
		return { ok: false, reason: "missing-model" };
	}
	if (!NATIVE_PROVIDERS.has(currentModel.provider)) {
		return { ok: false, reason: "unsupported-provider" };
	}
	if (!isNativeCompactionApi(currentModel.api)) {
		return { ok: false, reason: "unsupported-api" };
	}
	const baseUrl = normalizeBaseUrl(currentModel.baseUrl);
	if (!baseUrl) {
		return { ok: false, reason: "missing-base-url" };
	}
	if (payload !== undefined && !isResponsesRequestPayload(payload)) {
		return { ok: false, reason: "unsupported-payload" };
	}
	if (payload !== undefined && payload.model !== currentModel.id) {
		return { ok: false, reason: "payload-model-mismatch" };
	}

	return {
		ok: true,
		target: {
			provider: currentModel.provider,
			api: currentModel.api,
			model: currentModel.id,
			baseUrl,
			responsesUrl: buildResponsesUrl(baseUrl, currentModel.api),
			currentModel,
			payload,
		},
	};
}

export async function resolveNativeCompactionRuntime(
	ctx: ExtensionContext,
	target: NativeCompactionTarget,
): Promise<NativeCompactionRuntimeResolution> {
	const registry = ctx.modelRegistry as unknown as {
		getApiKeyAndHeaders?: (model: RuntimeModel) => Promise<
			| { ok: true; apiKey?: string; headers?: ProviderHeaders }
			| { ok: false; error: string }
		>;
	};
	if (typeof registry.getApiKeyAndHeaders !== "function") {
		return { ok: false, reason: "missing-api-key" };
	}

	try {
		const auth = await registry.getApiKeyAndHeaders(target.currentModel);
		if (!auth.ok || !auth.apiKey) {
			return { ok: false, reason: "missing-api-key" };
		}
		return {
			ok: true,
			runtime: {
				...target,
				apiKey: auth.apiKey,
				headers: auth.headers,
			},
		};
	} catch {
		return { ok: false, reason: "auth-error" };
	}
}
