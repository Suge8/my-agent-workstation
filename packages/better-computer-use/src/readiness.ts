import type { ChildProcess } from "node:child_process";
import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

interface ReadinessOptions {
	timeoutMs: number;
	description: string;
	signal?: AbortSignal;
}

function abortError(): Error {
	return new Error("Operation aborted.");
}

export async function waitForPathReady(
	filePath: string,
	start: () => void | Promise<void>,
	ready: () => boolean | Promise<boolean>,
	options: ReadinessOptions,
): Promise<void> {
	if (options.signal?.aborted) throw abortError();
	const directory = path.dirname(filePath);
	const filename = path.basename(filePath);
	await mkdir(directory, { recursive: true });
	const watcher = watch(directory);
	let checking = false;
	let eventQueued = false;
	let settled = false;
	let resolveReady!: () => void;
	let rejectReady!: (error: Error) => void;
	const completion = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
	const finish = (error?: Error) => {
		if (settled) return;
		settled = true;
		clearTimeout(timeout);
		watcher.close();
		options.signal?.removeEventListener("abort", onAbort);
		if (error) rejectReady(error);
		else resolveReady();
	};
	const check = async () => {
		if (settled) return;
		if (checking) {
			eventQueued = true;
			return;
		}
		checking = true;
		try {
			do {
				eventQueued = false;
				if (await ready()) {
					finish();
					return;
				}
			} while (eventQueued && !settled);
		} catch (error) {
			finish(error instanceof Error ? error : new Error(String(error)));
		} finally {
			checking = false;
		}
	};
	const onAbort = () => finish(abortError());
	const timeout = setTimeout(() => finish(new Error(`Timed out waiting for ${options.description}.`)), options.timeoutMs);
	watcher.on("change", (_event, changed) => {
		if (changed !== null && String(changed) !== filename) return;
		eventQueued = true;
		void check();
	});
	watcher.on("error", (error) => finish(error));
	options.signal?.addEventListener("abort", onAbort, { once: true });

	await check();
	if (!settled) {
		try { await start(); } catch (error) {
			finish(error instanceof Error ? error : new Error(String(error)));
		}
		if (!settled) await check();
	}
	await completion;
}

export function waitForCdpReady(
	child: ChildProcess,
	port: number,
	options: ReadinessOptions,
): Promise<void> {
	if (options.signal?.aborted) return Promise.reject(abortError());
	const stderr = child.stderr;
	if (!stderr) return Promise.reject(new Error("Managed browser stderr is unavailable."));
	stderr.setEncoding("utf8");
	return new Promise<void>((resolve, reject) => {
		let buffer = "";
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			stderr.removeListener("data", onData);
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			options.signal?.removeEventListener("abort", onAbort);
			stderr.resume();
			if (error) reject(error);
			else resolve();
		};
		const onData = (chunk: string) => {
			buffer = (buffer + chunk).slice(-8_192);
			const match = /DevTools listening on ws:\/\/.*:(\d+)\/devtools\/browser\//.exec(buffer);
			if (!match) return;
			const reportedPort = Number(match[1]);
			if (reportedPort !== port) {
				finish(new Error(`Managed browser reported CDP port ${reportedPort}, expected ${port}.`));
				return;
			}
			finish();
		};
		const onError = (error: Error) => finish(error);
		const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
			finish(new Error(`Managed browser exited before CDP was ready (${signal ?? code ?? "unknown"}).`));
		const onAbort = () => finish(abortError());
		const timeout = setTimeout(() => finish(new Error(`Timed out waiting for ${options.description}.`)), options.timeoutMs);
		stderr.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
		options.signal?.addEventListener("abort", onAbort, { once: true });
	});
}
