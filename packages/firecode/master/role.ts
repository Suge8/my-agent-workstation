import { AsyncLocalStorage } from "node:async_hooks";

export type SubsessionRole = "worker" | "observer" | "reviewer" | "advisor";

// pi 的扩展加载器（jiti，moduleCache: false）在子会话 cwd 变化或宿主 reload 后会重新
// 求值整个模块图：模块级变量在两份拷贝间互不相通，角色标记必须挂在进程唯一的 globalThis
// 上，否则新拷贝读不到 spawn 侧设置的角色，watcher/master 会级联注册进子会话。
const ROLE_KEY = Symbol.for("firecode.subsession-role");
const shared = globalThis as Record<symbol, AsyncLocalStorage<SubsessionRole> | undefined>;
const ROLE = (shared[ROLE_KEY] ??= new AsyncLocalStorage<SubsessionRole>());

export function currentSubsessionRole(): SubsessionRole | undefined {
	return ROLE.getStore();
}

export function withSubsessionRole<T>(role: SubsessionRole, run: () => Promise<T>): Promise<T> {
	return ROLE.run(role, run);
}
