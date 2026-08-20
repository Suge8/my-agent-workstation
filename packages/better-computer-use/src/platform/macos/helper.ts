import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setupHelperScriptPath } from "../../package-root.ts";
import { waitForPathReady } from "../../readiness.ts";
import { toBoolean, toFiniteNumber, toOptionalString } from "../coerce.ts";
import type { PlatformDiagnostics } from "../types.ts";

const COMMAND_TIMEOUT_MS = 15_000;
export const HELPER_PROTOCOL_VERSION = 6;
const HELPER_SETUP_TIMEOUT_MS = 60_000;

interface PendingResponse {
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
	signal?: AbortSignal;
	onAbort?: () => void;
}

export const HELPER_BUNDLE_ID = "dev.myagentworkstation.bcu";
export const HELPER_APP_PATH = process.env.BCU_HELPER_APP_PATH ?? "/Applications/bcu.app";
export const HELPER_APP_EXECUTABLE_PATH = path.join(HELPER_APP_PATH, "Contents", "MacOS", "bridge");
const DEFAULT_HELPER_SOCKET_PATH = path.join(os.homedir(), "Library", "Caches", "bcu", "bridge.sock");
export const HELPER_SOCKET_PATH = process.env.BCU_SOCKET_PATH ?? DEFAULT_HELPER_SOCKET_PATH;
const usingExternalHelperSocket = HELPER_SOCKET_PATH !== DEFAULT_HELPER_SOCKET_PATH;

export class HelperTransportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HelperTransportError";
	}
}

export class HelperCommandError extends Error {
	readonly code?: string;

	constructor(message: string, code?: string) {
		super(message);
		this.name = "HelperCommandError";
		this.code = code;
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Operation aborted.");
}

async function isExecutable(filePath: string): Promise<boolean> {
	try {
		await access(filePath, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export async function runProcess(
	command: string,
	args: string[],
	timeoutMs: number,
	signal?: AbortSignal,
	env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
	throwIfAborted(signal);

	return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			env,
		});

		let stderr = "";
		let stdout = "";

		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			cleanup();
			reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`));
		}, timeoutMs);

		const onAbort = () => {
			child.kill("SIGTERM");
			cleanup();
			reject(new Error("Operation aborted."));
		};

		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};

		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});

		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});

		child.on("error", (error) => {
			cleanup();
			reject(error);
		});

		child.on("close", (code) => {
			cleanup();
			if (code === 0) {
				resolve({ stdout, stderr });
				return;
			}
			const output = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
			reject(new Error(`Command failed (${code}): ${command} ${args.join(" ")}\n${output}`.trim()));
		});

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export class MacosHelperClient {
	private helperInstallChecked = false;
	private daemonAvailable = false;
	private requestSequence = 0;
	private diagnosticsCache?: PlatformDiagnostics;
	private socket?: net.Socket;
	private openingSocket?: net.Socket;
	private connecting?: Promise<net.Socket>;
	private buffer = "";
	private readonly pending = new Map<string, PendingResponse>();
	private readonly disconnectWaiters = new Set<() => void>();

	get diagnostics(): PlatformDiagnostics | undefined {
		return this.diagnosticsCache;
	}

	dispose(): void {
		this.daemonAvailable = false;
		this.openingSocket?.destroy();
		this.openingSocket = undefined;
		const socket = this.socket;
		this.socket = undefined;
		socket?.destroy();
		this.buffer = "";
		this.rejectPending(new HelperTransportError("bcu helper connection closed."));
		this.notifyDisconnected();
	}

	async ensureInstalled(signal?: AbortSignal): Promise<void> {
		if (usingExternalHelperSocket || this.helperInstallChecked) return;
		// Runtime setup repairs missing or replaced binaries while preserving an
		// intact older ad-hoc helper for the protocol check to arbitrate.
		const setupOutput = await runProcess(process.execPath, [setupHelperScriptPath(), "--runtime"], HELPER_SETUP_TIMEOUT_MS, signal, {
			...process.env,
			ELECTRON_RUN_AS_NODE: "1",
		});
		if (setupOutput.stderr) process.stderr.write(setupOutput.stderr);
		if (!(await isExecutable(HELPER_APP_EXECUTABLE_PATH))) {
			throw new Error(`Failed to install bcu helper app at ${HELPER_APP_PATH}.`);
		}
		this.helperInstallChecked = true;
	}

	async launchDaemon(signal?: AbortSignal): Promise<void> {
		if (usingExternalHelperSocket) throw new HelperTransportError(`External helper socket is unavailable at ${HELPER_SOCKET_PATH}.`);
		await mkdir(path.dirname(HELPER_SOCKET_PATH), { recursive: true });
		await runProcess("open", ["-n", "-g", "-b", HELPER_BUNDLE_ID, "--args", "serve", "--socket", HELPER_SOCKET_PATH], COMMAND_TIMEOUT_MS, signal);
	}

	private async connection(signal?: AbortSignal): Promise<net.Socket> {
		throwIfAborted(signal);
		if (this.socket && !this.socket.destroyed) return this.socket;
		if (!this.connecting) {
			const socket = net.createConnection(HELPER_SOCKET_PATH);
			this.openingSocket = socket;
			socket.setEncoding("utf8");
			const connecting = new Promise<net.Socket>((resolve, reject) => {
				let connected = false;
				socket.once("connect", () => {
					connected = true;
					this.openingSocket = undefined;
					this.socket = socket;
					this.buffer = "";
					resolve(socket);
				});
				socket.on("data", (chunk: string) => this.onData(chunk));
				socket.on("error", (error) => {
					const transportError = new HelperTransportError(error.message);
					if (!connected) reject(transportError);
					this.disconnect(socket, transportError);
				});
				socket.on("close", () => {
					const error = new HelperTransportError("bcu helper connection closed.");
					if (!connected) reject(error);
					this.disconnect(socket, error);
				});
			});
			const trackedConnection = connecting.finally(() => {
				if (this.connecting === trackedConnection) this.connecting = undefined;
				if (this.openingSocket === socket) this.openingSocket = undefined;
			});
			this.connecting = trackedConnection;
		}
		const connecting = this.connecting;
		if (!signal) return await connecting;
		return await new Promise<net.Socket>((resolve, reject) => {
			const onAbort = () => { cleanup(); reject(new Error("Operation aborted.")); };
			const cleanup = () => signal.removeEventListener("abort", onAbort);
			signal.addEventListener("abort", onAbort, { once: true });
			connecting.then(
				(socket) => { cleanup(); resolve(socket); },
				(error) => { cleanup(); reject(error); },
			);
		});
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (!line) continue;
			let parsed: any;
			try { parsed = JSON.parse(line); } catch { continue; }
			const pending = this.takePending(parsed?.id);
			if (!pending) continue;
			if (parsed.ok === true) pending.resolve(parsed.result);
			else pending.reject(new HelperCommandError(parsed?.error?.message ?? "Daemon command failed.", parsed?.error?.code));
		}
	}

	private takePending(id: unknown): PendingResponse | undefined {
		if (typeof id !== "string") return undefined;
		const pending = this.pending.get(id);
		if (!pending) return undefined;
		this.pending.delete(id);
		clearTimeout(pending.timer);
		if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
		return pending;
	}

	private disconnect(socket: net.Socket, error: HelperTransportError): void {
		if (this.socket !== socket) return;
		this.socket = undefined;
		socket.destroy();
		this.daemonAvailable = false;
		this.buffer = "";
		this.rejectPending(error);
		this.notifyDisconnected();
	}

	private notifyDisconnected(): void {
		for (const resolve of this.disconnectWaiters) resolve();
		this.disconnectWaiters.clear();
	}

	private waitForDisconnect(signal?: AbortSignal): Promise<void> {
		if (!this.socket) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timeout);
				this.disconnectWaiters.delete(onDisconnect);
				signal?.removeEventListener("abort", onAbort);
			};
			const onDisconnect = () => { cleanup(); resolve(); };
			const onAbort = () => { cleanup(); reject(new Error("Operation aborted.")); };
			const timeout = setTimeout(() => {
				cleanup();
				reject(new HelperTransportError("Timed out waiting for the old bcu helper to exit."));
			}, 3_000);
			this.disconnectWaiters.add(onDisconnect);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	private rejectPending(error: Error): void {
		for (const id of [...this.pending.keys()]) this.takePending(id)?.reject(error);
	}

	async daemonCommand<T>(cmd: string, args: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
		const socket = await this.connection(signal);
		throwIfAborted(signal);
		return await new Promise<T>((resolve, reject) => {
			const id = `req_${++this.requestSequence}`;
			const timer = setTimeout(() => {
				const pending = this.takePending(id);
				pending?.reject(new HelperTransportError(`Daemon command '${cmd}' timed out after ${timeoutMs}ms.`));
			}, timeoutMs);
			const onAbort = () => this.takePending(id)?.reject(new Error("Operation aborted."));
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, signal, onAbort });
			signal?.addEventListener("abort", onAbort, { once: true });
			socket.write(`${JSON.stringify({ id, cmd, ...args })}\n`, (error) => {
				if (error) this.takePending(id)?.reject(new HelperTransportError(error.message));
			});
		});
	}

	async ensureDaemon(signal?: AbortSignal): Promise<boolean> {
		if (this.daemonAvailable) return true;
		try {
			await waitForPathReady(
				HELPER_SOCKET_PATH,
				() => this.launchDaemon(signal),
				async () => {
					try {
						await this.daemonCommand("diagnostics", {}, 1_000, signal);
						this.daemonAvailable = true;
						return true;
					} catch (error) {
						throwIfAborted(signal);
						if (!(error instanceof HelperTransportError)) throw error;
						return false;
					}
				},
				{ timeoutMs: COMMAND_TIMEOUT_MS, description: "the bcu helper socket", signal },
			);
			return true;
		} catch (error) {
			throwIfAborted(signal);
			if (!(error instanceof HelperTransportError) && !String((error as Error)?.message).startsWith("Timed out waiting")) throw error;
			return false;
		}
	}

	async command<T>(cmd: string, args: Record<string, unknown> = {}, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<T> {
		const timeoutMs = options?.timeoutMs ?? COMMAND_TIMEOUT_MS;
		if (!(await this.ensureDaemon(options?.signal))) {
			throw new HelperTransportError(`bcu helper app daemon is unavailable at ${HELPER_APP_PATH}.`);
		}
		try {
			return await this.daemonCommand<T>(cmd, args, timeoutMs, options?.signal);
		} catch (error) {
			if (error instanceof HelperTransportError) this.daemonAvailable = false;
			throw error instanceof Error ? error : new Error(String(error));
		}
	}

	async restart(signal?: AbortSignal): Promise<void> {
		const disconnected = this.waitForDisconnect(signal);
		await this.command("shutdown", {}, { signal, timeoutMs: 2_000 }).catch(() => undefined);
		await disconnected;
		if (!(await this.ensureDaemon(signal))) {
			throw new Error(`bcu helper did not come back after restart. Helper app: ${HELPER_APP_PATH}`);
		}
	}

	async diagnosticsCommand(signal?: AbortSignal): Promise<PlatformDiagnostics> {
		const result = await this.command<any>("diagnostics", {}, { signal });
		const diagnostics = {
			protocolVersion: Math.trunc(toFiniteNumber(result?.protocolVersion, 0)),
			architectureVersion: Math.trunc(toFiniteNumber(result?.architectureVersion, 0)),
			invariants: Array.isArray(result?.invariants) ? result.invariants.filter((value: unknown): value is string => typeof value === "string") : [],
			pid: Math.trunc(toFiniteNumber(result?.pid, 0)),
			parentPid: Math.trunc(toFiniteNumber(result?.parentPid, 0)) || undefined,
			parentAppName: toOptionalString(result?.parentAppName),
			parentBundleId: toOptionalString(result?.parentBundleId),
			parentPath: toOptionalString(result?.parentPath),
			executablePath: toOptionalString(result?.executablePath),
			os: toOptionalString(result?.macOS),
			arch: toOptionalString(result?.arch),
			accessibility: toBoolean(result?.accessibility),
			screenRecording: toBoolean(result?.screenRecording),
		};
		this.diagnosticsCache = diagnostics;
		return diagnostics;
	}

	async ensureProtocol(signal?: AbortSignal): Promise<PlatformDiagnostics> {
		let diagnostics = await this.diagnosticsCommand(signal);
		if (diagnostics.protocolVersion === HELPER_PROTOCOL_VERSION) return diagnostics;

		// The helper daemon outlives a bcu process, so restarting the CLI alone does not
		// replace a daemon that is still serving the previous installed binary.
		// Stop it through the backwards-compatible command channel and relaunch
		// the app that ensureInstalled() has just synced to /Applications.
		await this.restart(signal);
		diagnostics = await this.diagnosticsCommand(signal);
		if (diagnostics.protocolVersion !== HELPER_PROTOCOL_VERSION) {
			this.daemonAvailable = false;
			throw new Error(`bcu helper protocol mismatch after relaunch: expected ${HELPER_PROTOCOL_VERSION}, got ${diagnostics.protocolVersion}. Reinstall or rebuild the helper app at ${HELPER_APP_PATH}.`);
		}
		return diagnostics;
	}
}

export const macosHelper = new MacosHelperClient();
