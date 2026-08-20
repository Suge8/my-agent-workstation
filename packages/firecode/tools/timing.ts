/** 工具真实执行耗时：execute 侧写入，渲染侧按 toolCallId 取走。 */
const durations = new Map<string, number>();

export async function executeTimed<T>(id: string, execute: () => Promise<T>): Promise<T> {
	const startedAt = performance.now();
	try {
		return await execute();
	} finally {
		durations.set(id, performance.now() - startedAt);
	}
}

/** 取一次即释放，避免长会话里堆积。 */
export function takeDuration(id: string): number | undefined {
	const duration = durations.get(id);
	if (duration !== undefined) durations.delete(id);
	return duration;
}

export function clearDurations(): void {
	durations.clear();
}
