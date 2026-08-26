import { afterEach, describe, expect, test } from "bun:test";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader.ts";

afterEach(cleanupFirecodeModules);

type Event = Record<string, unknown>;

function fakeRuntime(run: (emit: (event: Event) => void, aborted: Promise<void>) => Promise<void>) {
	let listener: ((event: Event) => void) | undefined;
	let abort!: () => void;
	const aborted = new Promise<void>((resolve) => { abort = resolve; });
	const session = {
		subscribe(next: (event: Event) => void) { listener = next; return () => { listener = undefined; }; },
		abort: async () => abort(),
	};
	const pool = {
		options: undefined as Record<string, unknown> | undefined,
		async spawn(options: Record<string, unknown>) {
			this.options = options;
			return {
				session,
				prompt: async () => run((event) => listener?.(event), aborted),
				dispose() { abort(); },
			};
		},
	};
	return { pool, session };
}

async function runner() {
	return await loadFirecodeModule("review/session.js") as {
		runReviewSession: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
	};
}

const base = (pool: unknown) => ({
	pool,
	resolveModel: async () => ({ id: "model" }),
	role: "reviewer",
	model: "provider/model",
	thinking: "high",
	tools: ["read", "bash", "write", "edit"],
	prompt: { system: "policy", user: "evidence" },
	cwd: process.cwd(),
	timeoutMs: 1_000,
});

describe("review in-process session", () => {
	test("returns the complete assistant output and forwards structured progress events", async () => {
		const body = `PASS\n${"完整结论 ".repeat(4000)}`;
		const runtime = fakeRuntime(async (emit) => {
			emit({ type: "tool_execution_start", toolName: "read", args: { path: "a.ts" } });
			emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: body }] } });
		});
		const seen: string[] = [];
		const { runReviewSession } = await runner();
		const result = await runReviewSession({
			...base(runtime.pool),
			onEvent: (event: Event) => seen.push(String(event.type)),
		});
		expect(result).toEqual({ kind: "output", text: body });
		expect(seen).toEqual(["tool_execution_start", "message_end"]);
		expect(runtime.pool.options).toMatchObject({
			role: "reviewer",
			tools: ["read", "bash"],
			contextFiles: false,
			isolated: true,
			persistence: { type: "memory" },
			systemPrompt: { mode: "replace", text: "policy" },
		});
	});

	test("a successful retry replaces the transient error result", async () => {
		const runtime = fakeRuntime(async (emit) => {
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "temporary failure" }],
					stopReason: "error",
					errorMessage: "429 rate limited",
				},
			});
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "PASS\n重试成功" }],
					stopReason: "stop",
				},
			});
		});
		const { runReviewSession } = await runner();
		expect(await runReviewSession(base(runtime.pool))).toEqual({
			kind: "output",
			text: "PASS\n重试成功",
		});
	});

	test("aborts the session when the caller cancels", async () => {
		const runtime = fakeRuntime(async (_emit, aborted) => aborted);
		const controller = new AbortController();
		const { runReviewSession } = await runner();
		const pending = runReviewSession({ ...base(runtime.pool), signal: controller.signal });
		controller.abort();
		expect(await pending).toEqual({ kind: "aborted" });
	});

	test("aborts the session and reports timeout when the deadline expires", async () => {
		const runtime = fakeRuntime(async (_emit, aborted) => aborted);
		const { runReviewSession } = await runner();
		expect(await runReviewSession({ ...base(runtime.pool), timeoutMs: 5 })).toEqual({ kind: "timeout" });
	});
});
