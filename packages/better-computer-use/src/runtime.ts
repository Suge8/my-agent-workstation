import { randomUUID } from "node:crypto";

export interface StoredState<T> {
	stateId: string;
	resourceKey: string;
	epoch: number;
	value: T;
}

export class StaleResourceStateError extends Error {
	readonly resourceKey: string;
	readonly expectedEpoch: number;
	readonly actualEpoch: number;

	constructor(resourceKey: string, expectedEpoch: number, actualEpoch: number) {
		super(`State is stale for ${resourceKey}: expected epoch ${expectedEpoch}, current epoch ${actualEpoch}.`);
		this.name = "StaleResourceStateError";
		this.resourceKey = resourceKey;
		this.expectedEpoch = expectedEpoch;
		this.actualEpoch = actualEpoch;
	}
}

export interface StateStoreOptions {
	maxEntries?: number;
	maxBytes?: number;
	maxRecordBytes?: number;
	ttlMs?: number;
	now?: () => number;
}

interface StateStoreRecord<T> {
	record: StoredState<T>;
	bytes: number;
	storedAt: number;
}

/** Count-, byte-, record-, and TTL-bounded store for immutable observations. */
export class StateStore<T> {
	private readonly records = new Map<string, StateStoreRecord<T>>();
	private readonly maxEntries: number;
	private readonly maxBytes: number;
	private readonly maxRecordBytes: number;
	private readonly ttlMs: number;
	private readonly now: () => number;
	private totalBytes = 0;

	constructor(options: number | StateStoreOptions = {}) {
		const resolved = typeof options === "number" ? { maxEntries: options } : options;
		this.maxEntries = resolved.maxEntries ?? 128;
		this.maxBytes = resolved.maxBytes ?? 32 * 1024 * 1024;
		this.maxRecordBytes = resolved.maxRecordBytes ?? 4 * 1024 * 1024;
		this.ttlMs = resolved.ttlMs ?? 10 * 60 * 1_000;
		this.now = resolved.now ?? Date.now;
	}

	create(resourceKey: string, epoch: number, value: T): StoredState<T> {
		const record = { stateId: randomUUID(), resourceKey, epoch, value };
		this.set(record);
		return record;
	}

	set(record: StoredState<T>): void {
		const storedAt = this.now();
		this.removeExpired(storedAt);
		const bytes = Buffer.byteLength(JSON.stringify(record));
		if (bytes > this.maxRecordBytes || bytes > this.maxBytes) {
			throw Object.assign(new Error(`State '${record.stateId}' is ${bytes} bytes, above the configured per-state capacity.`), { code: "state_too_large" });
		}
		this.remove(record.stateId);
		this.records.set(record.stateId, { record, bytes, storedAt });
		this.totalBytes += bytes;
		while (this.records.size > this.maxEntries || this.totalBytes > this.maxBytes) {
			const oldest = this.records.keys().next().value;
			if (!oldest) break;
			this.remove(oldest);
		}
	}

	get(stateId: string): StoredState<T> | undefined {
		const stored = this.records.get(stateId);
		if (!stored) return undefined;
		if (this.now() - stored.storedAt >= this.ttlMs) {
			this.remove(stateId);
			return undefined;
		}
		return stored.record;
	}

	clear(): void {
		this.records.clear();
		this.totalBytes = 0;
	}

	get size(): number {
		return this.records.size;
	}

	get byteSize(): number {
		return this.totalBytes;
	}

	private removeExpired(now: number): void {
		for (const [stateId, stored] of this.records) {
			if (now - stored.storedAt < this.ttlMs) continue;
			this.remove(stateId);
		}
	}

	private remove(stateId: string): void {
		const stored = this.records.get(stateId);
		if (!stored) return;
		this.records.delete(stateId);
		this.totalBytes -= stored.bytes;
	}
}

interface ResourceRecord {
	epoch: number;
	tail: Promise<void>;
}

/**
 * Orders live operations per physical resource while allowing unrelated
 * resources to overlap. Cached state queries bypass this scheduler entirely.
 */
export class ResourceScheduler {
	private readonly resources = new Map<string, ResourceRecord>();
	private closed = false;

	epoch(resourceKey: string): number {
		return this.resource(resourceKey).epoch;
	}

	restoreEpoch(resourceKey: string, epoch: number): void {
		const record = this.resource(resourceKey);
		record.epoch = Math.max(record.epoch, Math.max(0, Math.trunc(epoch)));
	}

	async read<T>(resourceKey: string, work: (epoch: number) => Promise<T>): Promise<{ value: T; epoch: number }> {
		return await this.enqueue(resourceKey, async (record) => ({ value: await work(record.epoch), epoch: record.epoch }));
	}

	async readAt<T>(resourceKey: string, expectedEpoch: number, work: (epoch: number) => Promise<T>): Promise<{ value: T; epoch: number }> {
		return await this.enqueue(resourceKey, async (record) => {
			if (record.epoch !== expectedEpoch) throw new StaleResourceStateError(resourceKey, expectedEpoch, record.epoch);
			return { value: await work(record.epoch), epoch: record.epoch };
		});
	}

	async write<T>(resourceKey: string, baseEpoch: number, work: (nextEpoch: number) => Promise<T>): Promise<{ value: T; epoch: number }> {
		return await this.enqueue(resourceKey, async (record) => {
			if (record.epoch !== baseEpoch) throw new StaleResourceStateError(resourceKey, baseEpoch, record.epoch);
			const nextEpoch = record.epoch + 1;
			// Invalidate the base state before dispatch. If native execution becomes
			// uncertain or throws after a partial effect, later writes still fail safe.
			record.epoch = nextEpoch;
			return { value: await work(nextEpoch), epoch: nextEpoch };
		});
	}

	async drain(): Promise<void> {
		await Promise.all([...this.resources.values()].map((record) => record.tail.catch(() => undefined)));
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.drain();
		this.resources.clear();
	}

	private resource(resourceKey: string): ResourceRecord {
		let record = this.resources.get(resourceKey);
		if (!record) {
			record = { epoch: 0, tail: Promise.resolve() };
			this.resources.set(resourceKey, record);
		}
		return record;
	}

	private async enqueue<T>(resourceKey: string, work: (record: ResourceRecord) => Promise<T>): Promise<T> {
		if (this.closed) throw new Error("Computer-use session is shutting down.");
		const record = this.resource(resourceKey);
		const previous = record.tail;
		let release!: () => void;
		const next = new Promise<void>((resolve) => { release = resolve; });
		record.tail = previous.catch(() => undefined).then(() => next);
		await previous.catch(() => undefined);
		try {
			return await work(record);
		} finally {
			release();
		}
	}
}
