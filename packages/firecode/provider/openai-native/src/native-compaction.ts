import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import type { CompactionResult, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { executeNativeCompaction, type NativeCompactionResult } from "./compact-client";
import {
	cloneStructuredValue,
	createNativeCompactionDetails,
	createNativeCompactionResult,
	resolveLatestNativeCompaction,
} from "./native-details";
import { rewriteNativeResponsesPayload, serializeLiveTailToResponsesInput } from "./native-replay";
import {
	resolveNativeCompactionRuntime,
	resolveNativeCompactionTarget,
	type ResponsesRequestPayload,
} from "./native-runtime";
import {
	serializeMessagesToCompactRequest,
	type NativeCompactionRequest,
} from "./responses-input";

type NativeCompactionHookResult = {
	cancel?: boolean;
	compaction?: CompactionResult;
};

function buildCompactionInstructions(systemPrompt: string, customInstructions?: string): string {
	const guidance = customInstructions?.trim();
	return guidance
		? `${systemPrompt}\n\nAdditional user guidance for this manual /compact request:\n${guidance}`
		: systemPrompt;
}

function reportCompactionFailure(ctx: ExtensionContext, message: string): void {
	const fullMessage = `pi-openai-native: ${message}`;
	if (ctx.hasUI) {
		ctx.ui.notify(fullMessage, "error");
		return;
	}
	console.error(fullMessage);
}

function cancelCompaction(ctx: ExtensionContext, message: string): NativeCompactionHookResult {
	reportCompactionFailure(ctx, message);
	return { cancel: true };
}

function failureMessage(result: Extract<NativeCompactionResult, { ok: false }>): string {
	const status = result.status ? ` (HTTP ${result.status})` : "";
	const detail = result.detail ? `: ${result.detail}` : "";
	const message = `native compaction failed: ${result.reason}${status}${detail}`;
	return message.endsWith(".") ? message : `${message}.`;
}

export async function compactWithOpenAINative(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
): Promise<NativeCompactionHookResult | undefined> {
	if (event.signal.aborted) {
		return { cancel: true };
	}

	const target = resolveNativeCompactionTarget(ctx);
	if (!target.ok) {
		return undefined;
	}

	const runtime = await resolveNativeCompactionRuntime(ctx, target.target);
	if (!runtime.ok) {
		return cancelCompaction(ctx, `native compaction is unavailable: ${runtime.reason}.`);
	}

	try {
		const latestCompaction = resolveLatestNativeCompaction(event.branchEntries, runtime.runtime);
		let request: NativeCompactionRequest;
		if (latestCompaction.ok) {
			const compactedWindow = latestCompaction.entry.details.compactedWindow.map(cloneStructuredValue);
			request = {
				model: runtime.runtime.model,
				input: [
					...compactedWindow,
					...serializeLiveTailToResponsesInput({
						model: runtime.runtime.currentModel,
						entries: event.branchEntries.slice(latestCompaction.index + 1),
					}),
				],
				instructions: buildCompactionInstructions(ctx.getSystemPrompt(), event.customInstructions),
			};
		} else if (latestCompaction.reason === "no-compaction") {
			request = serializeMessagesToCompactRequest({
				model: runtime.runtime.currentModel,
				messages: buildSessionContext(
					ctx.sessionManager.getEntries(),
					ctx.sessionManager.getLeafId(),
				).messages,
				instructions: buildCompactionInstructions(ctx.getSystemPrompt(), event.customInstructions),
			});
		} else {
			return undefined;
		}

		const result = await executeNativeCompaction({
			runtime: runtime.runtime,
			request,
			signal: event.signal,
		});
		if (!result.ok) {
			return result.reason === "aborted" ? { cancel: true } : cancelCompaction(ctx, failureMessage(result));
		}

		return {
			compaction: createNativeCompactionResult({
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details: createNativeCompactionDetails({
					provider: runtime.runtime.provider,
					api: runtime.runtime.api,
					model: runtime.runtime.model,
					baseUrl: runtime.runtime.baseUrl,
					compactedWindow: result.compactedWindow,
					createdAt: result.createdAt,
				}),
			}),
		};
	} catch (error) {
		return cancelCompaction(ctx, `native compaction failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function replayOpenAINative(
	payload: unknown,
	ctx: ExtensionContext,
): ResponsesRequestPayload | undefined {
	const target = resolveNativeCompactionTarget(ctx, payload);
	if (!target.ok || !target.target.payload) {
		return undefined;
	}

	const branchEntries = ctx.sessionManager.getBranch();
	const latestCompaction = resolveLatestNativeCompaction(branchEntries, target.target);
	if (!latestCompaction.ok) {
		return undefined;
	}

	const rewrite = rewriteNativeResponsesPayload({
		model: target.target.currentModel,
		payload: target.target.payload,
		branchEntries,
		compactionEntry: latestCompaction.entry,
	});
	return rewrite.ok ? rewrite.payload : undefined;
}
