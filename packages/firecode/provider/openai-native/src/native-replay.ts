import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	BranchSummaryEntry,
	CustomMessageEntry,
	SessionEntry,
	SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { cloneStructuredValue, type NativeCompactionEntry } from "./native-details";
import type { ResponsesRequestPayload } from "./native-runtime";
import {
	serializeMessagesToResponsesInput,
	type ResponsesInputContentItem,
	type ResponsesInputItem,
	type ResponsesInputMessageItem,
} from "./responses-input";

export type NativeReplayFailureReason =
	| "compaction-boundary-not-found"
	| "first-kept-entry-not-found"
	| "unsupported-instructions"
	| "invalid-compacted-window"
	| "unexpected-compaction-after-boundary"
	| "expected-pi-replay-mismatch";

export type NativeReplayResult =
	| { ok: true; payload: ResponsesRequestPayload }
	| { ok: false; reason: NativeReplayFailureReason };

type FreshPreamble = {
	leadingInput: ResponsesInputMessageItem[];
	trailingInput: ResponsesInputMessageItem[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isResponsesInputContentItem(value: unknown): value is ResponsesInputContentItem {
	if (!isRecord(value) || typeof value.type !== "string") {
		return false;
	}
	if (value.type === "input_text") {
		return typeof value.text === "string";
	}
	return value.type === "input_image" && value.detail === "auto" && typeof value.image_url === "string";
}

function isResponsesInputMessageItem(value: unknown): value is ResponsesInputMessageItem {
	if (!isRecord(value) || (value.role !== "user" && value.role !== "developer" && value.role !== "system")) {
		return false;
	}
	return typeof value.content === "string" || (Array.isArray(value.content) && value.content.every(isResponsesInputContentItem));
}

function isPromptEnvelopeItem(value: unknown): value is ResponsesInputMessageItem {
	return isResponsesInputMessageItem(value) && (value.role === "developer" || value.role === "system");
}

function cloneInputContent(item: ResponsesInputContentItem): ResponsesInputContentItem {
	return item.type === "input_text"
		? { type: "input_text", text: item.text }
		: { type: "input_image", detail: "auto", image_url: item.image_url };
}

function cloneInputMessage(item: ResponsesInputMessageItem): ResponsesInputMessageItem {
	return {
		role: item.role,
		content: typeof item.content === "string" ? item.content : item.content.map(cloneInputContent),
	};
}

function cloneResponsesInput(items: readonly unknown[]): ResponsesInputItem[] | undefined {
	try {
		return items.map((item) => cloneStructuredValue(item) as ResponsesInputItem);
	} catch {
		return undefined;
	}
}

function cloneCompactedWindow(items: readonly unknown[]): unknown[] | undefined {
	try {
		return items.map(cloneStructuredValue);
	} catch {
		return undefined;
	}
}

function areEquivalentValues(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) {
		return true;
	}
	if (Array.isArray(left) || Array.isArray(right)) {
		return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => areEquivalentValues(item, right[index]));
	}
	if (!isRecord(left) || !isRecord(right)) {
		return false;
	}
	const leftKeys = Object.keys(left).sort();
	const rightKeys = Object.keys(right).sort();
	return (
		areEquivalentValues(leftKeys, rightKeys) &&
		leftKeys.every((key) => areEquivalentValues(left[key], right[key]))
	);
}

function toBranchSummaryMessage(entry: BranchSummaryEntry): AgentMessage {
	return {
		role: "branchSummary",
		summary: entry.summary,
		fromId: entry.fromId,
		timestamp: new Date(entry.timestamp).getTime(),
	} as AgentMessage;
}

function toCustomMessage(entry: CustomMessageEntry): AgentMessage {
	return {
		role: "custom",
		customType: entry.customType,
		content: entry.content,
		display: entry.display,
		details: entry.details,
		timestamp: new Date(entry.timestamp).getTime(),
	} as AgentMessage;
}

function toReplayMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return (entry as SessionMessageEntry).message;
	}
	if (entry.type === "custom_message") {
		return toCustomMessage(entry);
	}
	if (entry.type === "branch_summary") {
		return toBranchSummaryMessage(entry);
	}
	return undefined;
}

function collectReplayMessages(entries: readonly SessionEntry[]): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (const entry of entries) {
		const message = toReplayMessage(entry);
		if (message) {
			messages.push(message);
		}
	}
	return messages;
}

function createCompactionSummary(entry: NativeCompactionEntry): AgentMessage {
	return {
		role: "compactionSummary",
		summary: entry.summary,
		tokensBefore: entry.tokensBefore,
		timestamp: new Date(entry.timestamp).getTime(),
	} as AgentMessage;
}

function extractFreshPreamble(payload: ResponsesRequestPayload): FreshPreamble | undefined {
	if (payload.instructions !== undefined && typeof payload.instructions !== "string") {
		return undefined;
	}

	let leadingBoundary = 0;
	while (leadingBoundary < payload.input.length && isPromptEnvelopeItem(payload.input[leadingBoundary])) {
		leadingBoundary += 1;
	}
	let trailingBoundary = payload.input.length;
	while (trailingBoundary > leadingBoundary && isPromptEnvelopeItem(payload.input[trailingBoundary - 1])) {
		trailingBoundary -= 1;
	}
	for (let index = leadingBoundary; index < trailingBoundary; index++) {
		if (isPromptEnvelopeItem(payload.input[index])) {
			return undefined;
		}
	}

	return {
		leadingInput: payload.input.slice(0, leadingBoundary).map((item) => cloneInputMessage(item as ResponsesInputMessageItem)),
		trailingInput: payload.input.slice(trailingBoundary).map((item) => cloneInputMessage(item as ResponsesInputMessageItem)),
	};
}

export function serializeLiveTailToResponsesInput<TApi extends Api>(args: {
	model: Model<TApi>;
	entries: readonly SessionEntry[];
}): ResponsesInputItem[] {
	return serializeMessagesToResponsesInput(args.model, collectReplayMessages(args.entries));
}

export function rewriteNativeResponsesPayload<TApi extends Api>(args: {
	model: Model<TApi>;
	payload: ResponsesRequestPayload;
	branchEntries: readonly SessionEntry[];
	compactionEntry: NativeCompactionEntry;
}): NativeReplayResult {
	const boundaryIndex = args.branchEntries.findIndex((entry) => entry.id === args.compactionEntry.id);
	if (boundaryIndex < 0) {
		return { ok: false, reason: "compaction-boundary-not-found" };
	}
	const firstKeptEntryIndex = args.branchEntries.findIndex(
		(entry, index) => index < boundaryIndex && entry.id === args.compactionEntry.firstKeptEntryId,
	);
	if (firstKeptEntryIndex < 0) {
		return { ok: false, reason: "first-kept-entry-not-found" };
	}

	const preamble = extractFreshPreamble(args.payload);
	if (!preamble) {
		return { ok: false, reason: "unsupported-instructions" };
	}
	if (args.branchEntries.slice(boundaryIndex + 1).some((entry) => entry.type === "compaction")) {
		return { ok: false, reason: "unexpected-compaction-after-boundary" };
	}

	const compactedWindow = cloneCompactedWindow(args.compactionEntry.details.compactedWindow);
	if (!compactedWindow) {
		return { ok: false, reason: "invalid-compacted-window" };
	}

	const preCompactionEntries = args.branchEntries.slice(firstKeptEntryIndex, boundaryIndex);
	const postCompactionEntries = args.branchEntries.slice(boundaryIndex + 1);
	const compactionSummaryInput = serializeMessagesToResponsesInput(args.model, [createCompactionSummary(args.compactionEntry)]);
	const preCompactionInput = serializeMessagesToResponsesInput(args.model, collectReplayMessages(preCompactionEntries));
	const postCompactionInput = serializeMessagesToResponsesInput(args.model, collectReplayMessages(postCompactionEntries));
	const expectedInput = [
		...preamble.leadingInput,
		...compactionSummaryInput,
		...preCompactionInput,
		...postCompactionInput,
		...preamble.trailingInput,
	];
	if (!areEquivalentValues(args.payload.input, expectedInput)) {
		return { ok: false, reason: "expected-pi-replay-mismatch" };
	}

	const tailStart = preamble.leadingInput.length + compactionSummaryInput.length + preCompactionInput.length;
	const tailEnd = args.payload.input.length - preamble.trailingInput.length;
	const tail = cloneResponsesInput(args.payload.input.slice(tailStart, tailEnd));
	if (!tail) {
		return { ok: false, reason: "expected-pi-replay-mismatch" };
	}

	return {
		ok: true,
		payload: {
			...args.payload,
			input: [...preamble.leadingInput, ...compactedWindow, ...tail, ...preamble.trailingInput],
		},
	};
}

