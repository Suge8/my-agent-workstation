import { afterEach, expect, mock, test } from "bun:test";
import { NATIVE_COMPACTION_SUMMARY, createNativeCompactionDetails } from "./native-details";
import type { OpenAINativeSettings } from "./config";

type AssistantPhase = "commentary" | "final_answer";

type ToolCallBlock = {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
};

type TextBlock = {
	type: "text";
	text: string;
	textSignature?: string;
};

type ThinkingBlock = {
	type: "thinking";
	thinking: string;
	thinkingSignature: string;
};

type TestModel = {
	provider: string;
	api: string;
	id: string;
	baseUrl: string;
	input: string[];
	reasoning: boolean;
};

type TestSessionEntry = {
	type: "message" | "compaction";
	id: string;
	timestamp: string;
	message?: Record<string, unknown>;
	summary?: string;
	firstKeptEntryId?: string;
	tokensBefore?: number;
	details?: ReturnType<typeof createNativeCompactionDetails>;
};

type HookHandler = (event: unknown, ctx: unknown) => Promise<unknown>;

type CompactClientResult =
	| {
			ok: true;
			compactedWindow: unknown[];
			createdAt?: string;
	  }
	| {
			ok: false;
			reason: "network-error" | "non-2xx" | "input-too-large" | "response-failed";
			status?: number;
			detail?: string;
	  };

type HookHarnessOptions = {
	compactResult?: CompactClientResult;
	settings?: Partial<OpenAINativeSettings>;
};

const defaultModel: TestModel = {
	provider: "openai",
	api: "openai-responses",
	id: "gpt-5-mini",
	baseUrl: "https://api.openai.com/v1",
	input: ["text"],
	reasoning: true,
};

const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:\n\n<summary>\n`;
const COMPACTION_SUMMARY_SUFFIX = `\n</summary>`;

let serializerImportCounter = 0;
let timestampCounter = 0;

function registerPiCodingAgentMock(): void {
	mock.module("@earendil-works/pi-coding-agent", () => ({
		buildSessionContext: (entries: Array<{ type: string; message?: Record<string, unknown> }>) => ({
			messages: entries.flatMap((entry) => (entry.type === "message" && entry.message ? [entry.message] : [])),
			thinkingLevel: "off",
			model: null,
		}),
		convertToLlm: (messages: Array<Record<string, unknown>>) =>
			messages
				.map((message) => {
					if (message.role === "compactionSummary") {
						return {
							role: "user",
							content: [
								{
									type: "text",
									text: `${COMPACTION_SUMMARY_PREFIX}${message.summary ?? ""}${COMPACTION_SUMMARY_SUFFIX}`,
								},
							],
							timestamp: message.timestamp,
						};
					}

					return message;
				})
				.filter(Boolean),
	}));
}

async function loadSerializerModule() {
	registerPiCodingAgentMock();
	return import(`./responses-input.ts?validation=${serializerImportCounter++}`);
}

async function serializeResponsesInput(model: TestModel, messages: Record<string, unknown>[]): Promise<unknown[]> {
	const { serializeMessagesToResponsesInput } = await loadSerializerModule();
	return serializeMessagesToResponsesInput(model as never, messages as never);
}

function createInputParitySignature(input: readonly unknown[]): string[] {
	return input.map((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			return typeof item;
		}
		const record = item as Record<string, unknown>;
		if (record.type === "message") {
			const phase = record.phase === "commentary" || record.phase === "final_answer" ? `:${record.phase}` : "";
			return `message:${typeof record.role === "string" ? record.role : "unknown"}${phase}`;
		}
		if (record.type === "function_call") {
			return `function_call:${typeof record.name === "string" ? record.name : "unknown"}`;
		}
		if (record.type === "function_call_output") {
			return "function_call_output";
		}
		if (record.type === "reasoning") {
			return "reasoning";
		}
		if (typeof record.role === "string") {
			const content = Array.isArray(record.content) ? `[${record.content.length}]` : "";
			return `input:${record.role}${content}`;
		}
		return typeof record.type === "string" ? `item:${record.type}` : "object";
	});
}

function nextTimestamp(): string {
	const timestamp = new Date(Date.UTC(2026, 2, 20, 12, 0, timestampCounter)).toISOString();
	timestampCounter += 1;
	return timestamp;
}

function createTextBlock(text: string, phase?: AssistantPhase, id = `msg_${timestampCounter}`): TextBlock {
	return {
		type: "text",
		text,
		...(phase
			? {
				textSignature: JSON.stringify({
					v: 1,
					id,
					phase,
				}),
			}
			: {}),
	};
}

function createThinkingBlock(thinking: string, item: Record<string, unknown>): ThinkingBlock {
	return {
		type: "thinking",
		thinking,
		thinkingSignature: JSON.stringify(item),
	};
}

function createToolCallBlock(
	callId: string,
	name: string,
	argumentsObject: Record<string, unknown>,
	itemId = `fc_${callId}`,
): ToolCallBlock {
	return {
		type: "toolCall",
		id: `${callId}|${itemId}`,
		name,
		arguments: argumentsObject,
	};
}

function createUserEntry(id: string, text: string): TestSessionEntry {
	return {
		type: "message",
		id,
		timestamp: nextTimestamp(),
		message: {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		},
	};
}

function createAssistantEntry(
	id: string,
	blocks: Array<TextBlock | ThinkingBlock | ToolCallBlock>,
	model: TestModel = defaultModel,
	stopReason: string = "stop",
): TestSessionEntry {
	return {
		type: "message",
		id,
		timestamp: nextTimestamp(),
		message: {
			role: "assistant",
			provider: model.provider,
			api: model.api,
			model: model.id,
			stopReason,
			content: blocks,
			timestamp: Date.now(),
		},
	};
}

function createToolResultEntry(id: string, toolCallId: string, toolName: string, text: string): TestSessionEntry {
	return {
		type: "message",
		id,
		timestamp: nextTimestamp(),
		message: {
			role: "toolResult",
			toolCallId,
			toolName,
			isError: false,
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		},
	};
}

function createCompactionEntry(args: {
	id: string;
	firstKeptEntryId: string;
	tokensBefore?: number;
	model?: TestModel;
	compactedWindow: unknown[];
}): TestSessionEntry {
	const model = args.model ?? defaultModel;
	return {
		type: "compaction",
		id: args.id,
		timestamp: nextTimestamp(),
		summary: NATIVE_COMPACTION_SUMMARY,
		firstKeptEntryId: args.firstKeptEntryId,
		tokensBefore: args.tokensBefore ?? 256,
		details: createNativeCompactionDetails({
			provider: model.provider,
			api: model.api,
			model: model.id,
			baseUrl: model.baseUrl,
			compactedWindow: args.compactedWindow,
			createdAt: nextTimestamp(),
		}),
	};
}

function createCompactionSummaryMessage(entry: TestSessionEntry): Record<string, unknown> {
	return {
		role: "compactionSummary",
		summary: entry.summary,
		tokensBefore: entry.tokensBefore,
		timestamp: new Date(entry.timestamp).getTime(),
	};
}

function toReplayMessage(entry: TestSessionEntry): Record<string, unknown> {
	if (entry.type !== "message" || !entry.message) {
		throw new Error(`Expected message entry, got ${entry.type}`);
	}
	return entry.message;
}

async function buildPiReplayPayload(args: {
	model?: TestModel;
	branchEntries: TestSessionEntry[];
	compactionEntry: TestSessionEntry;
	instructions: string;
	freshPreamble: string;
	trailingPreamble?: string[];
}): Promise<{
	model: string;
	instructions: string;
	input: unknown[];
}> {
	const model = args.model ?? defaultModel;
	const boundaryIndex = args.branchEntries.findIndex((entry) => entry.id === args.compactionEntry.id);
	if (boundaryIndex < 0) {
		throw new Error(`Missing compaction entry ${args.compactionEntry.id}`);
	}

	const firstKeptEntryIndex = args.branchEntries.findIndex(
		(entry, index) => index < boundaryIndex && entry.id === args.compactionEntry.firstKeptEntryId,
	);
	if (firstKeptEntryIndex < 0) {
		throw new Error(`Missing first-kept entry ${args.compactionEntry.firstKeptEntryId}`);
	}

	const preCompactionEntries = args.branchEntries.slice(firstKeptEntryIndex, boundaryIndex);
	const postCompactionEntries = args.branchEntries.slice(boundaryIndex + 1);
	const piReplayMessages = [
		createCompactionSummaryMessage(args.compactionEntry),
		...preCompactionEntries.map(toReplayMessage),
		...postCompactionEntries.map(toReplayMessage),
	];

	return {
		model: model.id,
		instructions: args.instructions,
		input: [
			{
				role: model.reasoning ? "developer" : "system",
				content: args.freshPreamble,
			},
			...(await serializeResponsesInput(model, piReplayMessages)),
			...((args.trailingPreamble ?? []).map((text) => ({
				role: "developer",
				content: [{ type: "input_text", text }],
			}))),
		],
	};
}

function createContext(args: {
	branchEntries?: TestSessionEntry[];
	model?: TestModel;
	systemPrompt?: string;
} = {}) {
	const branchEntries = args.branchEntries ?? [];
	const model = args.model ?? defaultModel;
	return {
		cwd: "/tmp/openai-native-compaction-validation",
		hasUI: false,
		getSystemPrompt: () => args.systemPrompt ?? "Current instructions v1",
		model,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture-key" }),
		},
		sessionManager: {
			getBranch: () => branchEntries,
			getEntries: () => branchEntries,
			getLeafId: () => branchEntries.at(-1)?.id ?? null,
			getSessionId: () => "session-validation",
			getSessionFile: () => "/tmp/openai-native-compaction-validation/session.json",
			getSessionDir: () => "/tmp/openai-native-compaction-validation",
		},
	};
}

async function loadHookHarness(options: HookHarnessOptions = {}): Promise<{
	sessionBeforeCompact: HookHandler;
	beforeProviderRequest: HookHandler;
	compactCalls: Array<Record<string, unknown>>;
}> {
	const compactCalls: Array<Record<string, unknown>> = [];

	registerPiCodingAgentMock();

	mock.module("./compact-client", () => ({
		executeNativeCompaction: async (args: Record<string, unknown>) => {
			compactCalls.push(args);
			return (
				options.compactResult ?? {
					ok: true,
					compactedWindow: [{ type: "message", role: "assistant", status: "completed", id: "cmp_default", content: [] }],
					createdAt: nextTimestamp(),
				}
			);
		},
	}));

	const { compactWithOpenAINative, replayOpenAINative } = await import(
		`./native-compaction.ts?test=${crypto.randomUUID()}`
	);
	const { rewriteOpenAIProviderRequest } = await import(`./request-pipeline.ts?test=${crypto.randomUUID()}`);
	const settings: OpenAINativeSettings = {
		nativeCompaction: options.settings?.nativeCompaction ?? true,
		providers: options.settings?.providers ?? {},
	};

	return {
		sessionBeforeCompact: async (event, ctx) =>
			settings.nativeCompaction ? compactWithOpenAINative(event as never, ctx as never) : undefined,
		beforeProviderRequest: async (event, ctx) => {
			const payload = (event as { payload: unknown }).payload;
			const nextPayload = rewriteOpenAIProviderRequest(payload, ctx as never, settings, undefined);
			return nextPayload === payload ? undefined : nextPayload;
		},
		compactCalls,
	};
}

afterEach(() => {
	serializerImportCounter = 0;
	timestampCounter = 0;
	mock.restore();
});

test("manual /compact preserves tool/result ordering + assistant phases and persists the native shim", async () => {
	const compactedWindow = [
		{ type: "message", role: "assistant", status: "completed", id: "cmp_1", phase: "commentary", content: [] },
	];
	const { sessionBeforeCompact, compactCalls } = await loadHookHarness({
		compactResult: {
			ok: true,
			compactedWindow,
			createdAt: nextTimestamp(),
		},
	});
	const model = { ...defaultModel };
	const toolCall = createToolCallBlock("call_docs", "search_docs", { query: "weekly release status" }, "fc_docs");
	const user = createUserEntry("entry_user", "Check the weekly release status.");
	const assistantCommentary = createAssistantEntry(
		"entry_assistant_commentary",
		[createTextBlock("Checking the docs first.", "commentary", "msg_commentary"), toolCall],
		model,
		"toolUse",
	);
	const toolResult = createToolResultEntry("entry_tool_result", toolCall.id, toolCall.name, "Release notes say green.");
	const assistantFinal = createAssistantEntry(
		"entry_assistant_final",
		[createTextBlock("The release is green.", "final_answer", "msg_final")],
		model,
		"stop",
	);
	const event = {
		branchEntries: [user, assistantCommentary, toolResult, assistantFinal],
		signal: new AbortController().signal,
		customInstructions: undefined,
		preparation: {
			tokensBefore: 512,
			firstKeptEntryId: user.id,
			previousSummary: undefined,
			messagesToSummarize: [
				toReplayMessage(user),
				toReplayMessage(assistantCommentary),
				toReplayMessage(toolResult),
				toReplayMessage(assistantFinal),
			],
			turnPrefixMessages: [],
		},
	};
	const result = (await sessionBeforeCompact(
		event,
		createContext({
			branchEntries: [user, assistantCommentary, toolResult, assistantFinal],
			model,
			systemPrompt: "Current instructions v1",
		}),
	)) as {
		compaction: Record<string, unknown>;
	};

	expect(compactCalls).toHaveLength(1);
	const compactRequest = compactCalls[0]?.request as { model: string; instructions: string; input: unknown[] };
	expect(compactRequest.model).toBe(model.id);
	expect(compactRequest.instructions).toBe("Current instructions v1");
	expect(await createInputParitySignature(compactRequest.input)).toEqual([
		"input:user[1]",
		"message:assistant:commentary",
		"function_call:search_docs",
		"function_call_output",
		"message:assistant:final_answer",
	]);
	expect(result.compaction.summary).toBe(NATIVE_COMPACTION_SUMMARY);
	expect(result.compaction.firstKeptEntryId).toBe(user.id);
	expect(result.compaction.tokensBefore).toBe(512);
	expect((result.compaction.details as { compactedWindow: unknown[] }).compactedWindow).toEqual(compactedWindow);
});

test("native compaction excludes foreign opaque reasoning without losing visible context", async () => {
	const { sessionBeforeCompact, compactCalls } = await loadHookHarness();
	const foreignModel: TestModel = {
		...defaultModel,
		provider: "xai",
		id: "grok-4.5",
	};
	const user = createUserEntry("cross_provider_user", "Inspect the repository.");
	const toolCall = createToolCallBlock("call_cross_provider", "read", { path: "README.md" }, "fc_cross_provider");
	const foreignAssistant = createAssistantEntry(
		"cross_provider_foreign_assistant",
		[
			createThinkingBlock("Foreign reasoning summary.", {
				type: "reasoning",
				id: "rs_xai",
				status: "completed",
				summary: [],
				encrypted_content: "xai-encrypted-content",
			}),
			createTextBlock("Reading the repository.", "commentary", "msg_xai"),
			toolCall,
		],
		foreignModel,
		"toolUse",
	);
	const toolResult = createToolResultEntry(
		"cross_provider_tool_result",
		toolCall.id,
		toolCall.name,
		"Repository contents.",
	);
	const currentAssistant = createAssistantEntry("cross_provider_current_assistant", [
		createThinkingBlock("Current reasoning summary.", {
			type: "reasoning",
			id: "rs_openai",
			summary: [],
			content: [],
			encrypted_content: "openai-encrypted-content",
		}),
		createTextBlock("Inspection complete.", "final_answer", "msg_openai"),
	]);
	const branchEntries = [user, foreignAssistant, toolResult, currentAssistant];

	await sessionBeforeCompact(
		{
			branchEntries,
			signal: new AbortController().signal,
			preparation: {
				tokensBefore: 512,
				firstKeptEntryId: user.id,
				messagesToSummarize: branchEntries.map(toReplayMessage),
				turnPrefixMessages: [],
			},
		},
		createContext({ branchEntries }),
	);

	const input = (compactCalls[0]?.request as { input: unknown[] }).input;
	const serialized = JSON.stringify(input);
	expect(await createInputParitySignature(input)).toEqual([
		"input:user[1]",
		"message:assistant",
		"message:assistant",
		"function_call:read",
		"function_call_output",
		"reasoning",
		"message:assistant:final_answer",
	]);
	expect(serialized).toContain("Foreign reasoning summary.");
	expect(serialized).toContain("Reading the repository.");
	expect(serialized).toContain("Repository contents.");
	expect(serialized).not.toContain("xai-encrypted-content");
	expect(serialized).toContain("openai-encrypted-content");
});

test("first native compaction sends the full current session context, including Pi's kept recent window", async () => {
	const { sessionBeforeCompact, compactCalls } = await loadHookHarness();
	const model = { ...defaultModel };
	const summarizedUser = createUserEntry("summarized_user", "Older context slated for summarization.");
	const keptUser = createUserEntry("kept_recent_user", "Recent kept window context that must also be compacted.");
	const event = {
		branchEntries: [summarizedUser, keptUser],
		signal: new AbortController().signal,
		customInstructions: undefined,
		preparation: {
			tokensBefore: 384,
			firstKeptEntryId: keptUser.id,
			previousSummary: undefined,
			messagesToSummarize: [toReplayMessage(summarizedUser)],
			turnPrefixMessages: [],
		},
	};

	await sessionBeforeCompact(
		event,
		createContext({
			branchEntries: [summarizedUser, keptUser],
			model,
			systemPrompt: "Current instructions include the kept window too",
		}),
	);

	const compactRequest = compactCalls[0]?.request as { model: string; instructions: string; input: unknown[] };
	expect(compactRequest.model).toBe(model.id);
	expect(compactRequest.instructions).toBe("Current instructions include the kept window too");
	expect(await createInputParitySignature(compactRequest.input)).toEqual(["input:user[1]", "input:user[1]"]);
	expect(JSON.stringify(compactRequest.input)).toContain("Recent kept window context that must also be compacted.");
});

test("repeated native compaction reuses the latest stored compacted window instead of Pi's shim summary", async () => {
	const { sessionBeforeCompact, compactCalls } = await loadHookHarness();
	const model = { ...defaultModel };
	const oldKeptUser = createUserEntry("old_kept_user", "Original context before native compaction.");
	const compactedWindow = [
		{
			type: "message",
			role: "assistant",
			status: "completed",
			id: "cmp_repeat",
			phase: "commentary",
			content: [{ type: "output_text", text: "Opaque compacted window", annotations: [] }],
		},
	];
	const priorCompaction = createCompactionEntry({
		id: "compaction_repeat",
		firstKeptEntryId: oldKeptUser.id,
		model,
		compactedWindow,
	});
	const tailUser = createUserEntry("repeat_tail_user", "New follow-up after the earlier native compaction.");
	const tailAssistant = createAssistantEntry(
		"repeat_tail_assistant",
		[createTextBlock("Follow-up answer after the earlier native compaction.", "final_answer", "msg_repeat_tail")],
		model,
		"stop",
	);
	const event = {
		branchEntries: [oldKeptUser, priorCompaction, tailUser, tailAssistant],
		signal: new AbortController().signal,
		customInstructions: undefined,
		preparation: {
			tokensBefore: 640,
			firstKeptEntryId: tailUser.id,
			previousSummary: NATIVE_COMPACTION_SUMMARY,
			messagesToSummarize: [],
			turnPrefixMessages: [],
		},
	};

	await sessionBeforeCompact(
		event,
		createContext({
			branchEntries: [oldKeptUser, priorCompaction, tailUser, tailAssistant],
			model,
			systemPrompt: "Current instructions v-repeat",
		}),
	);

	const compactRequest = compactCalls[0]?.request as { model: string; instructions: string; input: unknown[] };
	const expectedTail = await serializeResponsesInput(model, [toReplayMessage(tailUser), toReplayMessage(tailAssistant)]);
	expect(compactRequest.instructions).toBe("Current instructions v-repeat");
	expect(compactRequest.input).toEqual([...compactedWindow, ...expectedTail]);
	expect(JSON.stringify(compactRequest.input)).toContain("Opaque compacted window");
	expect(JSON.stringify(compactRequest.input)).not.toContain("The conversation history before this point was compacted");
	expect(JSON.stringify(compactRequest.input)).not.toContain("Original context before native compaction.");
});

test("session_before_compact fails open when the latest compaction is not native", async () => {
	const { sessionBeforeCompact, compactCalls } = await loadHookHarness();
	const model = { ...defaultModel };
	const olderUser = createUserEntry("older_non_native_user", "Context from before a non-native compaction.");
	const nonNativeCompaction: TestSessionEntry = {
		type: "compaction",
		id: "non_native_compaction",
		timestamp: nextTimestamp(),
		summary: "Legacy Pi summary",
		firstKeptEntryId: olderUser.id,
		tokensBefore: 512,
	};
	const currentUser = createUserEntry("current_after_non_native", "Current context after a non-native compaction.");
	const event = {
		branchEntries: [olderUser, nonNativeCompaction, currentUser],
		signal: new AbortController().signal,
		customInstructions: undefined,
		preparation: {
			tokensBefore: 768,
			firstKeptEntryId: currentUser.id,
			previousSummary: "Legacy Pi summary",
			messagesToSummarize: [],
			turnPrefixMessages: [],
		},
	};

	const result = await sessionBeforeCompact(
		event,
		createContext({
			branchEntries: [olderUser, nonNativeCompaction, currentUser],
			model,
			systemPrompt: "Current instructions after a non-native compaction",
		}),
	);

	expect(result).toBeUndefined();
	expect(compactCalls).toHaveLength(0);
});

test("first post-compaction turn rewrites to fresh preamble + opaque compacted window + live tail without duplication", async () => {
	const { beforeProviderRequest } = await loadHookHarness();
	const model = { ...defaultModel };
	const keptUser = createUserEntry("kept_user", "Old user context that Pi should stop duplicating.");
	const keptAssistant = createAssistantEntry(
		"kept_assistant",
		[createTextBlock("Old assistant context that should disappear after native replay.", "commentary", "msg_kept")],
		model,
	);
	const compactedWindow = [
		{ type: "message", role: "assistant", status: "completed", id: "cmp_commentary", phase: "commentary", content: [] },
		{
			type: "function_call",
			id: "fc_weather",
			call_id: "call_weather",
			name: "weather_lookup",
			arguments: '{"city":"Berlin"}',
		},
		{
			type: "function_call_output",
			call_id: "call_weather",
			output: "18°C and sunny",
		},
	];
	const compactionEntry = createCompactionEntry({
		id: "compaction_1",
		firstKeptEntryId: keptUser.id,
		model,
		compactedWindow,
	});
	const currentUser = createUserEntry("post_compaction_user", "Now summarize only the deploy risk.");
	const branchEntries = [keptUser, keptAssistant, compactionEntry, currentUser];
	const payload = await buildPiReplayPayload({
		model,
		branchEntries,
		compactionEntry,
		instructions: "Current instructions v2",
		freshPreamble: "Fresh preamble v2",
	});
	const rewritten = (await beforeProviderRequest(
		{ payload },
		createContext({ branchEntries, model, systemPrompt: payload.instructions }),
	)) as { input: unknown[]; instructions: string };
	const expectedTail = await serializeResponsesInput(model, [toReplayMessage(currentUser)]);
	const expectedInput = [payload.input[0], ...compactedWindow, ...expectedTail];

	expect(rewritten.instructions).toBe("Current instructions v2");
	expect(rewritten.input).toEqual(expectedInput);
	expect(JSON.stringify(rewritten.input)).not.toContain("Old user context that Pi should stop duplicating.");
	expect(JSON.stringify(rewritten.input)).not.toContain(
		"Old assistant context that should disappear after native replay.",
	);
	expect(JSON.stringify(rewritten.input)).not.toContain("The conversation history before this point was compacted");
});

test("trailing provider-authored developer prompts survive native replay in place", async () => {
	const { beforeProviderRequest } = await loadHookHarness();
	const model = { ...defaultModel, reasoning: true };
	const keptUser = createUserEntry("kept_for_trailing_prompt", "Older replay context that should disappear.");
	const compactedWindow = [
		{
			type: "compaction",
			encrypted_content: "opaque-compact-window",
		},
	];
	const compactionEntry = createCompactionEntry({
		id: "compaction_with_trailing_prompt",
		firstKeptEntryId: keptUser.id,
		model,
		compactedWindow,
	});
	const currentUser = createUserEntry("trailing_prompt_user", "Continue with the trailing developer hint preserved.");
	const branchEntries = [keptUser, compactionEntry, currentUser];
	const payload = await buildPiReplayPayload({
		model,
		branchEntries,
		compactionEntry,
		instructions: "Current instructions with trailing provider hint",
		freshPreamble: "Fresh preamble before replay",
		trailingPreamble: ["# Juice: 0 !important"],
	});
	const rewritten = (await beforeProviderRequest(
		{ payload },
		createContext({ branchEntries, model, systemPrompt: payload.instructions }),
	)) as { input: unknown[]; instructions: string };
	const expectedTail = await serializeResponsesInput(model, [toReplayMessage(currentUser)]);
	const trailingPrompt = payload.input[payload.input.length - 1];

	expect(rewritten.instructions).toBe("Current instructions with trailing provider hint");
	expect(rewritten.input).toEqual([payload.input[0], ...compactedWindow, ...expectedTail, trailingPrompt]);
	expect(rewritten.input[rewritten.input.length - 1]).toEqual(trailingPrompt);
});

test("multi-turn follow-up survives restart/resume while preserving tool/result pairing and assistant phases", async () => {
	const model = { ...defaultModel };
	const keptUser = createUserEntry("resume_kept_user", "Remember the earlier migration context.");
	const compactedWindow = [
		{
			type: "message",
			role: "assistant",
			status: "completed",
			id: "cmp_resume",
			phase: "commentary",
			content: [{ type: "output_text", text: "Compacted reasoning survives here.", annotations: [] }],
		},
	];
	const compactionEntry = createCompactionEntry({
		id: "resume_compaction",
		firstKeptEntryId: keptUser.id,
		model,
		compactedWindow,
	});
	const reviewCall = createToolCallBlock("call_review", "review_branch", { branch: "feature/native-compaction" }, "fc_review");
	const tailUser = createUserEntry("resume_tail_user", "Review the branch and call out risks.");
	const tailAssistantCommentary = createAssistantEntry(
		"resume_tail_assistant_commentary",
		[createTextBlock("Reviewing the branch now.", "commentary", "msg_tail_commentary"), reviewCall],
		model,
		"toolUse",
	);
	const tailToolResult = createToolResultEntry(
		"resume_tail_tool_result",
		reviewCall.id,
		reviewCall.name,
		"Found one medium-severity risk.",
	);
	const tailAssistantFinal = createAssistantEntry(
		"resume_tail_assistant_final",
		[createTextBlock("The main risk is stale replay state.", "final_answer", "msg_tail_final")],
		model,
	);
	const currentUser = createUserEntry("resume_current_user", "Which regression should I test first?");
	const branchEntries = [
		keptUser,
		compactionEntry,
		tailUser,
		tailAssistantCommentary,
		tailToolResult,
		tailAssistantFinal,
		currentUser,
	];
	const payload = await buildPiReplayPayload({
		model,
		branchEntries,
		compactionEntry,
		instructions: "Current instructions after restart",
		freshPreamble: "Fresh preamble after restart",
	});
	const firstHarness = await loadHookHarness();
	const resumedHarness = await loadHookHarness();
	const firstRewrite = (await firstHarness.beforeProviderRequest(
		{ payload },
		createContext({ branchEntries, model, systemPrompt: payload.instructions }),
	)) as { input: unknown[]; instructions: string };
	const resumedRewrite = (await resumedHarness.beforeProviderRequest(
		{ payload },
		createContext({ branchEntries, model, systemPrompt: payload.instructions }),
	)) as { input: unknown[]; instructions: string };
	const parity = await createInputParitySignature(firstRewrite.input);

	expect(resumedRewrite).toEqual(firstRewrite);
	expect(firstRewrite.instructions).toBe("Current instructions after restart");
	expect(parity).toEqual([
		"input:developer",
		"message:assistant:commentary",
		"input:user[1]",
		"message:assistant:commentary",
		"function_call:review_branch",
		"function_call_output",
		"message:assistant:final_answer",
		"input:user[1]",
	]);
});

test("a second compaction replays only the latest compacted window and keeps fresh instructions authoritative", async () => {
	const { beforeProviderRequest } = await loadHookHarness();
	const model = { ...defaultModel };
	const initialKeptUser = createUserEntry("initial_kept_user", "Initial context before the first compaction.");
	const firstCompaction = createCompactionEntry({
		id: "compaction_first",
		firstKeptEntryId: initialKeptUser.id,
		model,
		compactedWindow: [
			{
				type: "message",
				role: "assistant",
				status: "completed",
				id: "cmp_first",
				phase: "commentary",
				content: [{ type: "output_text", text: "First compaction window", annotations: [] }],
			},
		],
	});
	const interimUser = createUserEntry("interim_user", "Interim question between compactions.");
	const interimAssistant = createAssistantEntry(
		"interim_assistant",
		[createTextBlock("Interim answer between compactions.", "final_answer", "msg_interim")],
		model,
	);
	const secondCompactionWindow = [
		{
			type: "message",
			role: "assistant",
			status: "completed",
			id: "cmp_second",
			phase: "commentary",
			content: [{ type: "output_text", text: "Second compaction window", annotations: [] }],
		},
	];
	const secondCompaction = createCompactionEntry({
		id: "compaction_second",
		firstKeptEntryId: interimUser.id,
		model,
		compactedWindow: secondCompactionWindow,
	});
	const currentUser = createUserEntry("post_second_compaction_user", "What changed after the second compaction?");
	const branchEntries = [
		initialKeptUser,
		firstCompaction,
		interimUser,
		interimAssistant,
		secondCompaction,
		currentUser,
	];
	const payload = await buildPiReplayPayload({
		model,
		branchEntries,
		compactionEntry: secondCompaction,
		instructions: "Newest instructions win",
		freshPreamble: "Newest preamble wins too",
	});
	const rewritten = (await beforeProviderRequest(
		{ payload },
		createContext({ branchEntries, model, systemPrompt: payload.instructions }),
	)) as { input: unknown[]; instructions: string };

	expect(rewritten.instructions).toBe("Newest instructions win");
	expect(rewritten.input).toEqual([
		payload.input[0],
		...secondCompactionWindow,
		...(await serializeResponsesInput(model, [toReplayMessage(currentUser)])),
	]);
	expect(JSON.stringify(rewritten.input)).toContain("Second compaction window");
	expect(JSON.stringify(rewritten.input)).not.toContain("First compaction window");
	expect(JSON.stringify(rewritten.input)).not.toContain("Interim question between compactions.");
});

test("unsupported model/provider switching fails open instead of replaying stale native state", async () => {
	const { beforeProviderRequest } = await loadHookHarness();
	const matchingModel = { ...defaultModel };
	const switchedModel = {
		...defaultModel,
		id: "gpt-5-nano",
	};
	const unsupportedProviderModel = {
		...defaultModel,
		provider: "anthropic",
		api: "anthropic-messages",
		id: "claude-sonnet-4",
	};
	const keptUser = createUserEntry("switch_kept_user", "Original context before switching models.");
	const olderMatchingCompaction = createCompactionEntry({
		id: "switch_compaction_old",
		firstKeptEntryId: keptUser.id,
		model: matchingModel,
		compactedWindow: [{ type: "message", role: "assistant", status: "completed", id: "cmp_old", content: [] }],
	});
	const newerMismatchedCompaction = createCompactionEntry({
		id: "switch_compaction_new",
		firstKeptEntryId: keptUser.id,
		model: switchedModel,
		compactedWindow: [{ type: "message", role: "assistant", status: "completed", id: "cmp_new", content: [] }],
	});
	const branchEntries = [keptUser, olderMatchingCompaction, newerMismatchedCompaction];
	const matchingPayload = {
		model: matchingModel.id,
		instructions: "Instructions after switching back",
		input: [{ role: "developer", content: "Fresh preamble after switching back" }],
	};
	const mismatchedLatestResult = await beforeProviderRequest(
		{ payload: matchingPayload },
		createContext({ branchEntries, model: matchingModel, systemPrompt: matchingPayload.instructions }),
	);
	const unsupportedProviderResult = await beforeProviderRequest(
		{ payload: { ...matchingPayload, model: unsupportedProviderModel.id } },
		createContext({ branchEntries, model: unsupportedProviderModel, systemPrompt: matchingPayload.instructions }),
	);

	expect(mismatchedLatestResult).toBeUndefined();
	expect(unsupportedProviderResult).toBeUndefined();
});

test("native replay runs before configured Responses options", async () => {
	const model = { ...defaultModel };
	const keptUser = createUserEntry("pipeline_kept", "Old context that must not be replayed.");
	const compactedWindow = [{ type: "message", role: "assistant", status: "completed", id: "cmp_pipeline", content: [] }];
	const compactionEntry = createCompactionEntry({
		id: "pipeline_compaction",
		firstKeptEntryId: keptUser.id,
		model,
		compactedWindow,
	});
	const currentUser = createUserEntry("pipeline_current", "Current context remains live.");
	const branchEntries = [keptUser, compactionEntry, currentUser];
	const payload = await buildPiReplayPayload({
		model,
		branchEntries,
		compactionEntry,
		instructions: "Current instructions",
		freshPreamble: "Fresh preamble",
	});
	const { beforeProviderRequest } = await loadHookHarness({
		settings: {
			providers: {
				openai: { textVerbosity: "high", priority: true },
			},
		},
	});

	const rewritten = (await beforeProviderRequest(
		{ payload },
		createContext({ branchEntries, model, systemPrompt: payload.instructions }),
	)) as { input: unknown[]; text: { verbosity: string }; service_tier: string };

	expect(rewritten.input).toEqual([
		payload.input[0],
		...compactedWindow,
		...(await serializeResponsesInput(model, [toReplayMessage(currentUser)])),
	]);
	expect(rewritten.text).toEqual({ verbosity: "high" });
	expect(rewritten.service_tier).toBe("priority");
});

test("an over-window native compaction reports its full terminal failure without falling back", async () => {
	const detail = '{"code":"context_length_exceeded","message":"Your input exceeds the context window of this model."}';
	const { sessionBeforeCompact, compactCalls } = await loadHookHarness({
		compactResult: { ok: false, reason: "input-too-large", detail },
	});
	const user = createUserEntry("over_window_user", "Keep the complete context.");
	const notifications: Array<[string, string]> = [];
	const result = await sessionBeforeCompact(
		{
			branchEntries: [user],
			signal: new AbortController().signal,
			preparation: {
				tokensBefore: 200001,
				firstKeptEntryId: user.id,
				previousSummary: undefined,
				messagesToSummarize: [toReplayMessage(user)],
				turnPrefixMessages: [],
			},
		},
		{
			...createContext({ branchEntries: [user] }),
			hasUI: true,
			ui: {
				notify: (message: string, type: string) => notifications.push([message, type]),
			},
		},
	);

	expect(result).toEqual({ cancel: true });
	expect(compactCalls).toHaveLength(1);
	expect(notifications).toEqual([
		[`pi-openai-native: native compaction failed: input-too-large: ${detail}.`, "error"],
	]);
});

test("an eligible native compaction failure cancels instead of silently falling back", async () => {
	const { sessionBeforeCompact, compactCalls } = await loadHookHarness({
		compactResult: {
			ok: false,
			reason: "non-2xx",
			status: 400,
			detail: "Invalid input type 'compaction_trigger'.",
		},
	});
	const user = createUserEntry("failed_compaction_user", "Keep this context.");
	const notifications: Array<[string, string]> = [];
	const result = await sessionBeforeCompact(
		{
			branchEntries: [user],
			signal: new AbortController().signal,
			preparation: {
				tokensBefore: 256,
				firstKeptEntryId: user.id,
				previousSummary: undefined,
				messagesToSummarize: [toReplayMessage(user)],
				turnPrefixMessages: [],
			},
		},
		{
			...createContext({ branchEntries: [user] }),
			hasUI: true,
			ui: {
				notify: (message: string, type: string) => notifications.push([message, type]),
			},
		},
	);

	expect(result).toEqual({ cancel: true });
	expect(compactCalls).toHaveLength(1);
	expect(notifications).toEqual([
		["pi-openai-native: native compaction failed: non-2xx (HTTP 400): Invalid input type 'compaction_trigger'.", "error"],
	]);
});
