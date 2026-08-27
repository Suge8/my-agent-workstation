import { afterAll, expect, test } from "bun:test";
import { cleanupFirecodeModules, loadFirecodeModule } from "./loader";

afterAll(cleanupFirecodeModules);

// pi 的扩展加载器（jiti，moduleCache: false）在子会话 cwd 变化或宿主 reload 后会重新
// 求值整个模块图：spawn 侧与子会话入口可能各持一份 role.ts 拷贝。角色标记必须跨拷贝
// 可见，否则 watcher/master 会以 "main" 角色级联注册进 Worker 会话。
test("子会话角色跨模块拷贝可见", async () => {
	const spawnSide = (await loadFirecodeModule("master/role.js")) as {
		withSubsessionRole: (role: string, run: () => Promise<unknown>) => Promise<unknown>;
	};
	const freshCopy = (await loadFirecodeModule("master/role.js")) as {
		currentSubsessionRole: () => string | undefined;
	};
	const seen = await spawnSide.withSubsessionRole("worker", async () => freshCopy.currentSubsessionRole());
	expect(seen).toBe("worker");
});
