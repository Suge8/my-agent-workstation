import { AsyncLocalStorage } from "node:async_hooks";

export type SubsessionRole = "worker" | "observer" | "reviewer" | "advisor";

const ROLE = new AsyncLocalStorage<SubsessionRole>();

export function currentSubsessionRole(): SubsessionRole | undefined {
	return ROLE.getStore();
}

export function withSubsessionRole<T>(role: SubsessionRole, run: () => Promise<T>): Promise<T> {
	return ROLE.run(role, run);
}
