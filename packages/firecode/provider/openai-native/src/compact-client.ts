import type { NativeCompactionRuntime } from "./native-runtime";
import type { NativeCompactionRequest } from "./responses-input";

const JSON_CONTENT_TYPE = "application/json";
const COMPACTION_TRIGGER = { type: "compaction_trigger" } as const;
const RETAINED_MESSAGE_TOKEN_BUDGET = 64_000;

type ParsedOutput = {
	output: Record<string, unknown>[];
	createdAt?: unknown;
};

type ParsedFailure = {
	reason: "input-too-large" | "response-failed";
	detail?: string;
};

export type NativeCompactionFailureReason =
	| "aborted"
	| "network-error"
	| "non-2xx"
	| "empty-body"
	| "invalid-json"
	| "malformed-response"
	| "missing-compaction"
	| "input-too-large"
	| "response-failed";

export type NativeCompactionResult =
	| {
			ok: true;
			compactedWindow: unknown[];
			createdAt?: string;
	  }
	| {
			ok: false;
			reason: NativeCompactionFailureReason;
			status?: number;
			detail?: string;
	  };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
	return (
		(error instanceof DOMException && error.name === "AbortError") ||
		(error instanceof Error && (error.name === "AbortError" || error.name === "ABORT_ERR"))
	);
}

function normalizeResponseTimestamp(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		const milliseconds = value > 1_000_000_000_000 ? value : value * 1000;
		return new Date(milliseconds).toISOString();
	}
	if (typeof value !== "string" || !value.trim()) {
		return undefined;
	}
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? value.trim() : new Date(parsed).toISOString();
}

function errorMessage(value: unknown): string | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	if (typeof value.message === "string" && value.message.trim()) {
		return value.message.trim();
	}
	if (isRecord(value.error)) {
		return errorMessage(value.error);
	}
	if (isRecord(value.response)) {
		return errorMessage(value.response);
	}
	return undefined;
}

function providerError(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	if (isRecord(value.error)) {
		return value.error;
	}
	return providerError(value.response);
}

function parseFailedResponse(value: unknown): ParsedFailure | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const response = isRecord(value.response) ? value.response : value;
	if (value.type !== "response.failed" && value.type !== "error" && response.status !== "failed") {
		return undefined;
	}
	const error = providerError(value);
	const code = typeof error?.code === "string" ? error.code : undefined;
	const detail = error ? JSON.stringify(error) : errorMessage(value);
	return {
		reason: code === "context_length_exceeded" ? "input-too-large" : "response-failed",
		...(detail ? { detail } : {}),
	};
}

function parseErrorDetail(responseText: string): string | undefined {
	try {
		return errorMessage(JSON.parse(responseText));
	} catch {
		return undefined;
	}
}

function isOutputArray(value: unknown): value is Record<string, unknown>[] {
	return Array.isArray(value) && value.every(isRecord);
}

function parseJsonOutput(value: unknown): ParsedOutput | undefined {
	if (!isRecord(value) || !isOutputArray(value.output)) {
		return undefined;
	}
	return { output: value.output, createdAt: value.created_at };
}

function parseSseOutput(responseText: string): ParsedOutput | ParsedFailure | undefined {
	let completed: ParsedOutput | undefined;
	const streamedItems: Record<string, unknown>[] = [];
	let failure: ParsedFailure | undefined;
	for (const block of responseText.split(/\r?\n\r?\n/)) {
		const data = block
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n");
		if (!data || data === "[DONE]") {
			continue;
		}
		let event: unknown;
		try {
			event = JSON.parse(data);
		} catch {
			continue;
		}
		if (!isRecord(event)) {
			continue;
		}
		if (event.type === "response.output_item.done" && isRecord(event.item)) {
			streamedItems.push(event.item);
			continue;
		}
		if (event.type === "response.completed") {
			completed = parseJsonOutput(event.response) ?? {
				output: [],
				createdAt: isRecord(event.response) ? event.response.created_at : undefined,
			};
			continue;
		}
		failure = parseFailedResponse(event) ?? failure;
	}
	if (completed?.output.length) {
		return completed;
	}
	if (completed && streamedItems.length > 0) {
		return { output: streamedItems, createdAt: completed.createdAt };
	}
	return failure;
}

function parseResponseOutput(responseText: string):
	| { ok: true; parsed: ParsedOutput }
	| { ok: false; reason: "invalid-json" | "malformed-response" | ParsedFailure["reason"]; detail?: string } {
	const trimmed = responseText.trim();
	if (trimmed.startsWith("{")) {
		try {
			const value = JSON.parse(trimmed);
			const failure = parseFailedResponse(value);
			if (failure) {
				return { ok: false, ...failure };
			}
			const parsed = parseJsonOutput(value);
			if (parsed) {
				return { ok: true, parsed };
			}
			const detail = errorMessage(value);
			return { ok: false, reason: "malformed-response", ...(detail ? { detail } : {}) };
		} catch {
			return { ok: false, reason: "invalid-json" };
		}
	}

	const sse = parseSseOutput(trimmed);
	if (sse && "output" in sse) {
		return { ok: true, parsed: sse };
	}
	return sse
		? { ok: false, ...sse }
		: { ok: false, reason: "malformed-response" };
}

function isRetainedInputItem(value: unknown): value is Record<string, unknown> {
	return isRecord(value) && (value.role === "user" || value.role === "developer" || value.role === "system");
}

function itemText(item: Record<string, unknown>): string {
	if (typeof item.content === "string") {
		return item.content;
	}
	if (!Array.isArray(item.content)) {
		return "";
	}
	return item.content
		.filter(isRecord)
		.map((part) => (typeof part.text === "string" ? part.text : ""))
		.join("");
}

function estimateTokens(item: Record<string, unknown>): number {
	return Math.max(1, Math.ceil(itemText(item).length / 4));
}

function buildCompactedWindow(input: unknown[], compactionItem: Record<string, unknown>): unknown[] {
	const retained: Record<string, unknown>[] = [];
	let remaining = RETAINED_MESSAGE_TOKEN_BUDGET;
	for (let index = input.length - 1; index >= 0 && remaining > 0; index--) {
		const item = input[index];
		if (!isRetainedInputItem(item)) {
			continue;
		}
		const tokens = estimateTokens(item);
		if (tokens > remaining) {
			continue;
		}
		retained.push(structuredClone(item));
		remaining -= tokens;
	}
	retained.reverse();
	return [...retained, structuredClone(compactionItem)];
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) {
		return undefined;
	}
	try {
		const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
		return isRecord(payload) ? payload : undefined;
	} catch {
		return undefined;
	}
}

function codexAccountId(token: string): string | undefined {
	const authClaims = decodeJwtPayload(token)?.["https://api.openai.com/auth"];
	if (!isRecord(authClaims) || typeof authClaims.chatgpt_account_id !== "string") {
		return undefined;
	}
	return authClaims.chatgpt_account_id.trim() || undefined;
}

function buildHeaders(runtime: NativeCompactionRuntime): Record<string, string> {
	const headers = new Headers(runtime.currentModel.headers ?? {});
	for (const [key, value] of Object.entries(runtime.headers ?? {})) {
		if (value === null) headers.delete(key);
		else headers.set(key, value);
	}
	headers.set("accept", "text/event-stream, application/json");
	headers.set("content-type", JSON_CONTENT_TYPE);
	if (!headers.has("authorization")) {
		headers.set("authorization", `Bearer ${runtime.apiKey}`);
	}
	if (runtime.provider === "openai-codex") {
		const accountId = codexAccountId(runtime.apiKey);
		if (accountId) {
			headers.set("chatgpt-account-id", accountId);
		}
		headers.set("originator", "pi");
		headers.set("user-agent", `pi (${process.platform}; ${process.arch})`);
		headers.set("openai-beta", "responses=experimental");
	}
	return Object.fromEntries(headers.entries());
}

export async function executeNativeCompaction(args: {
	runtime: NativeCompactionRuntime;
	request: NativeCompactionRequest;
	signal?: AbortSignal;
}): Promise<NativeCompactionResult> {
	const { runtime, request, signal } = args;
	if (signal?.aborted) {
		return { ok: false, reason: "aborted" };
	}

	try {
		// 输入是否超窗由服务端裁决（context_length_exceeded → input-too-large）：
		// 本地字符估算既不准也是第二事实源，历史上曾把正常触发线（窗口 − 预留）上的压缩全部误拒。
		const input = [...request.input, COMPACTION_TRIGGER];
		const response = await fetch(runtime.responsesUrl, {
			method: "POST",
			headers: buildHeaders(runtime),
			body: JSON.stringify({
				model: request.model,
				instructions: request.instructions,
				input,
				store: false,
				stream: true,
			}),
			signal,
		});
		const responseText = await response.text();
		if (!response.ok) {
			const detail = parseErrorDetail(responseText);
			return {
				ok: false,
				reason: "non-2xx",
				status: response.status,
				...(detail ? { detail } : {}),
			};
		}
		if (!responseText.trim()) {
			return { ok: false, reason: "empty-body", status: response.status };
		}

		const parsed = parseResponseOutput(responseText);
		if (!parsed.ok) {
			return { ...parsed, status: response.status };
		}

		const compactionItems = parsed.parsed.output.filter((item) => item.type === "compaction");
		if (compactionItems.length !== 1) {
			return { ok: false, reason: "missing-compaction", status: response.status };
		}

		return {
			ok: true,
			compactedWindow: buildCompactedWindow(request.input, compactionItems[0]!),
			createdAt: normalizeResponseTimestamp(parsed.parsed.createdAt),
		};
	} catch (error) {
		return isAbortError(error)
			? { ok: false, reason: "aborted" }
			: {
					ok: false,
					reason: "network-error",
					detail: error instanceof Error ? error.message : String(error),
				};
	}
}
