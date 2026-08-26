import type { Model } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevelValue } from "../config.js";
import type { InProcessSessionPool } from "../master/spawn.js";
import type { PromptLayers } from "./prompt.js";

export type ReviewSessionResult =
	| { kind: "output"; text: string }
	| { kind: "empty" }
	| { kind: "timeout" }
	| { kind: "aborted" }
	| { kind: "error"; message: string };

export interface ReviewSessionOptions {
	pool: InProcessSessionPool;
	resolveModel(id: string): Promise<Model<any>>;
	role: "reviewer" | "advisor";
	model: string;
	thinking: ThinkingLevelValue;
	tools: string[];
	prompt: PromptLayers;
	cwd: string;
	timeoutMs: number;
	signal?: AbortSignal;
	onEvent?: (event: AgentSessionEvent) => void;
}

export type ReviewSessionRunner = (
	options: Omit<ReviewSessionOptions, "pool" | "resolveModel">,
) => Promise<ReviewSessionResult>;

export function createReviewSessionRunner(
	pool: InProcessSessionPool,
	resolveModel: ReviewSessionOptions["resolveModel"],
): ReviewSessionRunner {
	return (options) => runReviewSession({ ...options, pool, resolveModel });
}

export async function runReviewSession(options: ReviewSessionOptions): Promise<ReviewSessionResult> {
	if (options.signal?.aborted) return { kind: "aborted" };
	let spawned: Awaited<ReturnType<InProcessSessionPool["spawn"]>>;
	try {
		spawned = await options.pool.spawn({
			cwd: options.cwd,
			role: options.role,
			model: await options.resolveModel(options.model),
			thinking: options.thinking,
			tools: [...new Set(options.tools)].filter((tool) => tool !== "write" && tool !== "edit"),
			systemPrompt: { mode: "replace", text: clean(options.prompt.system) },
			contextFiles: false,
			persistence: { type: "memory" },
			isolated: true,
		});
	} catch (error) {
		return options.signal?.aborted
			? { kind: "aborted" }
			: { kind: "error", message: errorText(error) };
	}
	if (options.signal?.aborted) {
		spawned.dispose();
		return { kind: "aborted" };
	}

	let finalText: string | undefined;
	let finalError: string | undefined;
	const unsubscribe = spawned.session.subscribe((event) => {
		const assistant = assistantMessage(event);
		if (assistant) {
			finalText = messageText(assistant.content);
			finalError = assistant.stopReason === "error"
				? assistant.errorMessage || "model error"
				: undefined;
		}
		options.onEvent?.(event);
	});
	let interrupted: "aborted" | "timeout" | undefined;
	let wake!: () => void;
	const interruption = new Promise<void>((resolve) => { wake = resolve; });
	const onAbort = () => { interrupted = "aborted"; wake(); };
	options.signal?.addEventListener("abort", onAbort, { once: true });
	const timeout = setTimeout(() => { interrupted = "timeout"; wake(); }, options.timeoutMs);
	try {
		const run = spawned.prompt(clean(options.prompt.user)).catch((error) => {
			finalError = errorText(error);
		});
		await Promise.race([run, interruption]);
		if (interrupted) {
			await spawned.session.abort();
			return { kind: interrupted };
		}
		if (finalError) return { kind: "error", message: finalError };
		return finalText?.trim() ? { kind: "output", text: finalText } : { kind: "empty" };
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", onAbort);
		unsubscribe();
		spawned.dispose();
	}
}

function assistantMessage(event: AgentSessionEvent): {
	role?: string;
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
} | undefined {
	if (event.type === "message_end") return event.message.role === "assistant" ? event.message : undefined;
	if (event.type !== "agent_end") return undefined;
	return [...event.messages].reverse().find((message) => message.role === "assistant");
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
			&& typeof (part as { text?: unknown }).text === "string")
		.map((part) => part.text)
		.join("\n");
}

function clean(text: string): string {
	return text.replaceAll("\0", "");
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
