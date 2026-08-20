/**
 * 配额结果的跨进程缓存：同时开多个 pi 会话时共享一次抓取，
 * 也共享失败退避，避免离线时每个进程各自重试。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { QuotaWindow } from "./quota-parse.js";

export type QuotaCacheEntry = {
	/** 抓取成功的窗口；失败时为空数组 */
	windows: QuotaWindow[];
	/** 早于此刻不再发起请求（成功用 TTL，失败用退避） */
	nextAttemptAt: number;
	/** 连续失败次数，驱动退避档位 */
	failures: number;
};

export interface QuotaCache {
	read(provider: string): QuotaCacheEntry | undefined;
	write(provider: string, entry: QuotaCacheEntry): void;
}

function isEntry(value: unknown): value is QuotaCacheEntry {
	const entry = value as QuotaCacheEntry | undefined;
	return (
		!!entry &&
		typeof entry === "object" &&
		Array.isArray(entry.windows) &&
		typeof entry.nextAttemptAt === "number" &&
		typeof entry.failures === "number"
	);
}

/** 每个 provider 一个文件，避免多进程写入互相覆盖。 */
export function fileQuotaCache(directory: string): QuotaCache {
	const pathFor = (provider: string) =>
		join(directory, `firecode-quota-${provider}.json`);

	return {
		read(provider) {
			try {
				const parsed: unknown = JSON.parse(readFileSync(pathFor(provider), "utf8"));
				return isEntry(parsed) ? parsed : undefined;
			} catch {
				return undefined;
			}
		},
		write(provider, entry) {
			const path = pathFor(provider);
			const temporary = `${path}.${process.pid}.tmp`;
			try {
				mkdirSync(directory, { recursive: true });
				writeFileSync(temporary, JSON.stringify(entry));
				renameSync(temporary, path);
			} catch {
				// 缓存是加速手段，写失败只意味着下次照常请求
			}
		},
	};
}
