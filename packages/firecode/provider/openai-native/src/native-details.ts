import type { CompactionEntry, CompactionResult, SessionEntry } from "@earendil-works/pi-coding-agent";

export const NATIVE_COMPACTION_STRATEGY = "openai-native-compact";
export const NATIVE_COMPACTION_SUMMARY = "[OpenAI native compaction checkpoint]";

export type NativeCompactionIdentity = {
	provider: string;
	api: string;
	model: string;
	baseUrl: string;
};

export type NativeCompactionDetails = NativeCompactionIdentity & {
	strategy: typeof NATIVE_COMPACTION_STRATEGY;
	compactedWindow: unknown[];
	createdAt: string;
};

export type NativeCompactionEntry = CompactionEntry<NativeCompactionDetails> & {
	details: NativeCompactionDetails;
};

type NativeCompactionResolution =
	| {
			ok: true;
			entry: NativeCompactionEntry;
			index: number;
	  }
	| {
			ok: false;
			reason: "no-compaction" | "latest-compaction-not-native" | "latest-native-compaction-mismatch";
	  };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isStructuredValue(value: unknown): boolean {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return true;
	}
	if (Array.isArray(value)) {
		return value.every(isStructuredValue);
	}
	return isRecord(value) && Object.values(value).every(isStructuredValue);
}

function isCompactedWindowItem(value: unknown): value is Record<string, unknown> {
	return isRecord(value) && Object.values(value).every(isStructuredValue);
}

function hasNativeCompactionIdentity(value: Record<string, unknown>): boolean {
	return (
		isNonEmptyString(value.provider) &&
		isNonEmptyString(value.api) &&
		isNonEmptyString(value.model) &&
		isNonEmptyString(value.baseUrl)
	);
}

export function cloneStructuredValue(value: unknown): unknown {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(cloneStructuredValue);
	}
	if (isRecord(value)) {
		return Object.fromEntries(Object.entries(value).map(([key, nestedValue]) => [key, cloneStructuredValue(nestedValue)]));
	}
	throw new Error(`Unsupported structured value: ${typeof value}`);
}

export function isNativeCompactionDetails(value: unknown): value is NativeCompactionDetails {
	if (!isRecord(value) || value.strategy !== NATIVE_COMPACTION_STRATEGY || !hasNativeCompactionIdentity(value)) {
		return false;
	}

	return (
		Array.isArray(value.compactedWindow) &&
		value.compactedWindow.every(isCompactedWindowItem) &&
		isNonEmptyString(value.createdAt)
	);
}

function isNativeCompactionEntry(value: SessionEntry | undefined): value is NativeCompactionEntry {
	return value?.type === "compaction" && isNativeCompactionDetails(value.details);
}

export function createNativeCompactionDetails(input: NativeCompactionIdentity & {
	compactedWindow: unknown[];
	createdAt?: string;
}): NativeCompactionDetails {
	const identity: NativeCompactionIdentity = {
		provider: input.provider.trim(),
		api: input.api.trim(),
		model: input.model.trim(),
		baseUrl: input.baseUrl.trim(),
	};
	if (!identity.provider || !identity.api || !identity.model || !identity.baseUrl) {
		throw new Error("Native compaction identity is incomplete");
	}

	if (!input.compactedWindow.every(isCompactedWindowItem)) {
		throw new Error("Native compaction window contains an invalid item");
	}

	return {
		strategy: NATIVE_COMPACTION_STRATEGY,
		...identity,
		compactedWindow: input.compactedWindow.map(cloneStructuredValue),
		createdAt: isNonEmptyString(input.createdAt) ? input.createdAt.trim() : new Date().toISOString(),
	};
}

export function createNativeCompactionResult(input: {
	firstKeptEntryId: string;
	tokensBefore: number;
	details: NativeCompactionDetails;
}): CompactionResult<NativeCompactionDetails> {
	return {
		summary: NATIVE_COMPACTION_SUMMARY,
		firstKeptEntryId: input.firstKeptEntryId,
		tokensBefore: input.tokensBefore,
		details: input.details,
	};
}

export function resolveLatestNativeCompaction(
	entries: readonly SessionEntry[],
	identity: NativeCompactionIdentity,
): NativeCompactionResolution {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "compaction") {
			continue;
		}
		if (!isNativeCompactionEntry(entry)) {
			return { ok: false, reason: "latest-compaction-not-native" };
		}
		if (
			entry.details.provider !== identity.provider ||
			entry.details.api !== identity.api ||
			entry.details.model !== identity.model ||
			entry.details.baseUrl !== identity.baseUrl
		) {
			return { ok: false, reason: "latest-native-compaction-mismatch" };
		}
		return { ok: true, entry, index };
	}

	return { ok: false, reason: "no-compaction" };
}
