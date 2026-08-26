import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STATE_VERSION = 7;

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type WorkerThinking = (typeof THINKING_LEVELS)[number];
export type WorkerStatus = "working" | "idle" | "reviewing";
export type WorkerDisposition = "pending" | "reminded";

export interface WorkerRef {
	name: string;
	model: string;
	thinking: WorkerThinking;
	status: WorkerStatus;
	sessionPath: string;
	cwd?: string;
	interruptedAt?: number;
	reviewNeeded?: boolean;
	disposition?: WorkerDisposition;
}

export interface MasterState {
	version: typeof STATE_VERSION;
	workers: WorkerRef[];
}

export type MasterEvent =
	| { type: "UPSERT_WORKER"; worker: WorkerRef }
	| { type: "REMOVE_WORKER"; name: string }
	| { type: "CLEAR" };

export function initialMasterState(): MasterState {
	return { version: STATE_VERSION, workers: [] };
}

export function reduceMaster(state: MasterState, event: MasterEvent): MasterState {
	switch (event.type) {
		case "UPSERT_WORKER":
			return { ...state, workers: upsertWorker(state.workers, event.worker) };
		case "REMOVE_WORKER": {
			const workers = state.workers.filter((worker) => worker.name !== event.name);
			return workers.length === state.workers.length ? state : { ...state, workers };
		}
		case "CLEAR":
			return initialMasterState();
	}
}

export function recoverMasterState(state: MasterState, interruptedAt = Date.now()): MasterState {
	let changed = false;
	const workers = state.workers.map((worker) => {
		if (worker.status === "idle") return worker;
		changed = true;
		return { ...worker, status: "idle" as const, interruptedAt };
	});
	return changed ? { ...state, workers } : state;
}

export function restoreMasterState(data: unknown): MasterState | undefined {
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const record = data as Record<string, unknown>;
	if (record.version !== STATE_VERSION || !Array.isArray(record.workers) || !record.workers.every(isWorker))
		return undefined;
	const workers = record.workers as WorkerRef[];
	if (new Set(workers.map((worker) => worker.name)).size !== workers.length) return undefined;
	if (new Set(workers.map((worker) => worker.sessionPath)).size !== workers.length) return undefined;
	return { version: STATE_VERSION, workers };
}

export class LegacyMasterStateError extends Error {
	constructor(readonly version: number) {
		super(
			`Master Worker Pool 状态是旧版 v${version}（当前 v${STATE_VERSION}），不再读取；`
			+ "重新启动指挥官模式会从空池重建，旧运行时进程不会纳入新池，需要手动清理",
		);
	}
}

export function masterStatePath(sessionId: string): string {
	const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/gu, "-");
	return join(homedir(), ".pi", "agent", "tmp", `firecode-master-${safeId}.json`);
}

export function loadMasterState(path: string): MasterState | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		throw new Error(`Master Worker Pool 状态不是合法 JSON：${path}`);
	}
	const version = (data as { version?: unknown } | null)?.version;
	if (typeof version === "number" && version !== STATE_VERSION) throw new LegacyMasterStateError(version);
	const state = restoreMasterState(data);
	if (!state) throw new Error(`Master Worker Pool 状态结构无效：${path}`);
	return state;
}

export class MasterStore {
	private stateValue: MasterState;
	private readonly path: string;
	private readonly onChange?: () => void;
	readonly discardedLegacyVersion?: number;

	constructor(path: string, restored?: MasterState, onChange?: () => void) {
		this.path = path;
		this.onChange = onChange;
		if (restored) this.stateValue = restored;
		else {
			const loaded = this.loadOwnedState();
			this.stateValue = loaded.state;
			this.discardedLegacyVersion = loaded.discardedLegacyVersion;
		}
	}

	get state(): MasterState {
		return this.stateValue;
	}

	dispatch(event: MasterEvent): MasterState {
		const next = reduceMaster(this.stateValue, event);
		if (next === this.stateValue) return next;
		if (event.type === "CLEAR") rmSync(this.path, { force: true });
		else writeState(this.path, next);
		this.stateValue = next;
		this.onChange?.();
		return next;
	}

	private loadOwnedState(): { state: MasterState; discardedLegacyVersion?: number } {
		try {
			return { state: loadMasterState(this.path) ?? initialMasterState() };
		} catch (error) {
			if (!(error instanceof LegacyMasterStateError)) throw error;
			rmSync(this.path, { force: true });
			return { state: initialMasterState(), discardedLegacyVersion: error.version };
		}
	}
}

export function requireWorker(state: MasterState, name: string): WorkerRef {
	const worker = state.workers.find((candidate) => candidate.name === name);
	if (!worker) throw new Error(`子代理不存在：${name}`);
	return worker;
}

function writeState(path: string, state: MasterState): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

function upsertWorker(workers: WorkerRef[], worker: WorkerRef): WorkerRef[] {
	const index = workers.findIndex((candidate) => candidate.name === worker.name);
	const sessionOwner = workers.find((candidate) => candidate.sessionPath === worker.sessionPath);
	if (sessionOwner && sessionOwner.name !== worker.name)
		throw new Error(`sessionPath 已被占用：${worker.sessionPath}`);
	if (index < 0) return [...workers, worker];
	if (workers[index].sessionPath !== worker.sessionPath)
		throw new Error(`子代理 ${worker.name} 不能更换 sessionPath`);
	return workers.map((candidate, position) => (position === index ? worker : candidate));
}

function isWorker(value: unknown): value is WorkerRef {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (
		typeof record.name !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/u.test(record.name) ||
		typeof record.model !== "string" || !record.model ||
		typeof record.thinking !== "string" || !THINKING_LEVELS.includes(record.thinking as WorkerThinking) ||
		typeof record.status !== "string" || !isStatus(record.status) ||
		typeof record.sessionPath !== "string" || !record.sessionPath
	) return false;
	if (record.cwd !== undefined && (typeof record.cwd !== "string" || !record.cwd)) return false;
	if (record.interruptedAt !== undefined && (typeof record.interruptedAt !== "number" || record.interruptedAt <= 0))
		return false;
	if (record.reviewNeeded !== undefined && typeof record.reviewNeeded !== "boolean") return false;
	if (record.disposition !== undefined && record.disposition !== "pending" && record.disposition !== "reminded")
		return false;
	return true;
}

function isStatus(value: string): value is WorkerStatus {
	return value === "working" || value === "idle" || value === "reviewing";
}
