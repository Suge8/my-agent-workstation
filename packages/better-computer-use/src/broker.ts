import { chmodSync, closeSync, constants as fsConstants, mkdirSync, openSync, unlinkSync, writeSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { materializeScreenshot } from "./artifacts.ts";
import {
	executeAct,
	executeEvaluateBrowser,
	executeExpandUi,
	executeFind,
	executeInspectUi,
	executeLaunchBrowser,
	executeNavigateBrowser,
	executeObserve,
	executeReadText,
	executeSearchUi,
	executeWaitFor,
	shutdownComputerUseSession,
} from "./bridge.ts";
import type {
	ActParams,
	EvaluateBrowserParams,
	ExpandUiParams,
	FindParams,
	InspectUiParams,
	LaunchBrowserParams,
	NavigateBrowserParams,
	ObserveParams,
	ReadTextParams,
	SearchUiParams,
	ToolResult,
	WaitForParams,
} from "./contract.ts";
import { loadComputerUseConfig } from "./config.ts";
import { normalizeCliError, toolResultFailure } from "./errors.ts";
import {
	BROKER_PROTOCOL_VERSION,
	BROKER_SOCKET_PATH,
	BROKER_SOCKET_USES_FILESYSTEM,
	decodeJsonLines,
	parseBrokerRequest,
	type BrokerError,
	type BrokerHandshake,
	type BrokerRequest,
	type BrokerResponse,
} from "./ipc.ts";
import { HELPER_APP_PATH, HELPER_PROTOCOL_VERSION, macosHelper } from "./platform/macos/helper.ts";
import { checkMacosPermissions } from "./platform/macos/permissions.ts";
import { ensurePermissions } from "./permissions.ts";
import { StaleResourceStateError } from "./runtime.ts";

const DEFAULT_IDLE_MS = 10 * 60 * 1_000;

const MACOS_O_EXLOCK = 0x20;

function acquireStartupLock(): number | undefined {
	if (!BROKER_SOCKET_USES_FILESYSTEM) return undefined;
	if (process.platform !== "darwin") throw new Error(`bcu broker IPC does not support platform '${process.platform}'.`);
	const directory = path.dirname(BROKER_SOCKET_PATH);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	return openSync(`${BROKER_SOCKET_PATH}.startup.lock`, fsConstants.O_CREAT | fsConstants.O_RDWR | MACOS_O_EXLOCK, 0o600);
}

function releaseStartupLock(fileDescriptor: number | undefined): void {
	if (fileDescriptor !== undefined) closeSync(fileDescriptor);
}

function unlinkBrokerSocket(): void {
	if (!BROKER_SOCKET_USES_FILESYSTEM) return;
	try {
		unlinkSync(BROKER_SOCKET_PATH);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function connectionSucceeds(socketPath: string): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", (error: NodeJS.ErrnoException) => {
			socket.destroy();
			if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(false);
			else reject(error);
		});
	});
}

async function prepareSocketPath(): Promise<boolean> {
	if (await connectionSucceeds(BROKER_SOCKET_PATH)) return false;
	unlinkBrokerSocket();
	return true;
}

function helperProtocolVersion(): number {
	return HELPER_PROTOCOL_VERSION;
}

async function helperDiagnostics(): Promise<unknown> {
	await macosHelper.ensureInstalled();
	if (!(await macosHelper.ensureDaemon())) throw Object.assign(new Error(`bcu helper app daemon is unavailable at ${HELPER_APP_PATH}.`), { code: "helper_unavailable" });
	return await macosHelper.ensureProtocol();
}

async function doctor(): Promise<unknown> {
	const helper = await helperDiagnostics();
	const permissions = process.platform === "darwin" ? await checkMacosPermissions() : undefined;
	return {
		broker: { pid: process.pid, protocolVersion: BROKER_PROTOCOL_VERSION },
		platform: process.platform,
		helper,
		permissions,
		config: loadComputerUseConfig(),
	};
}

async function setup(phase: unknown): Promise<unknown> {
	if (process.platform !== "darwin") throw Object.assign(new Error(`bcu requires Apple Silicon macOS, got '${process.platform}'.`), { code: "unsupported_platform" });
	await helperDiagnostics();
	if (phase === "register") return await macosHelper.command("registerPermissions");
	if (phase !== "complete") throw Object.assign(new Error("setup phase must be 'register' or 'complete'."), { code: "invalid_args" });
	await macosHelper.restart();
	const permissions = await checkMacosPermissions();
	ensurePermissions(permissions, ["accessibility", "screenRecording"], "bcu still lacks required macOS permissions.");
	return { platform: "darwin", ready: true, permissions };
}

async function withArtifact(result: ToolResult): Promise<ToolResult> {
	const failure = toolResultFailure(result);
	if (failure) throw failure;
	return await materializeScreenshot(result);
}

async function dispatchCommand(request: BrokerRequest): Promise<unknown> {
	switch (request.cmd) {
		case "ping": return { pid: process.pid };
		case "diagnostics": return await helperDiagnostics();
		case "doctor": return await doctor();
		case "setup": return await setup(request.args.phase);
		case "find-roots": return await withArtifact(await executeFind(request.args as FindParams));
		case "observe-ui": return await withArtifact(await executeObserve(request.args as ObserveParams));
		case "search-ui": return await withArtifact(await executeSearchUi(request.args as SearchUiParams));
		case "expand-ui": return await withArtifact(await executeExpandUi(request.args as unknown as ExpandUiParams));
		case "inspect-ui": return await withArtifact(await executeInspectUi(request.args as unknown as InspectUiParams));
		case "act-ui": return await withArtifact(await executeAct(request.args as unknown as ActParams));
		case "read-text": return await withArtifact(await executeReadText(request.args as ReadTextParams));
		case "wait-for": return await withArtifact(await executeWaitFor(request.args as WaitForParams));
		case "launch-browser": return await withArtifact(await executeLaunchBrowser(request.args as LaunchBrowserParams));
		case "navigate-browser": return await withArtifact(await executeNavigateBrowser(request.args as unknown as NavigateBrowserParams));
		case "evaluate-browser": return await withArtifact(await executeEvaluateBrowser(request.args as unknown as EvaluateBrowserParams));
		default: throw Object.assign(new Error(`Unknown broker command '${request.cmd}'.`), { code: "unknown_command" });
	}
}

function brokerError(error: unknown): BrokerError {
	const normalized = error instanceof StaleResourceStateError
		? Object.assign(error, { code: "stale_state" })
		: error;
	const cliError = normalizeCliError(normalized);
	return { message: cliError.message, code: cliError.code };
}

function send(socket: net.Socket, response: BrokerResponse): void {
	if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
}

function idleMilliseconds(): number {
	const injected = Number(process.env.BCU_IDLE_MS);
	return Number.isFinite(injected) && injected >= 0 ? injected : DEFAULT_IDLE_MS;
}

function signalReady(): void {
	try {
		writeSync(3, "1");
		closeSync(3);
	} catch {}
}

export async function serveBroker(): Promise<void> {
	// The launching client destroys our stderr pipe once startup completes; a later
	// write (e.g. codesign output passthrough) must not crash the daemon with EPIPE.
	process.stderr.on("error", () => {});
	let startupLock = acquireStartupLock();
	let shouldStart: boolean;
	try {
		shouldStart = await prepareSocketPath();
	} catch (error) {
		releaseStartupLock(startupLock);
		throw error;
	}
	if (!shouldStart) {
		releaseStartupLock(startupLock);
		return;
	}
	const server = net.createServer();
	const sockets = new Set<net.Socket>();
	let activeConnections = 0;
	let inFlightRequests = 0;
	let idleTimer: NodeJS.Timeout | undefined;
	let stopping = false;
	let finish!: () => void;
	let fail!: (error: Error) => void;
	const stopped = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });

	const clearIdle = () => {
		if (!idleTimer) return;
		clearTimeout(idleTimer);
		idleTimer = undefined;
	};
	const stop = async (cause?: Error) => {
		if (stopping) return;
		stopping = true;
		clearIdle();
		const cleanupLock = acquireStartupLock();
		let finalError = cause;
		try {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			try { await shutdownComputerUseSession(); } catch (error) {
				finalError ??= error instanceof Error ? error : new Error(String(error));
			}
			try { unlinkBrokerSocket(); } catch (error) {
				finalError ??= error instanceof Error ? error : new Error(String(error));
			}
		} finally {
			releaseStartupLock(cleanupLock);
		}
		if (finalError) fail(finalError);
		else finish();
	};
	const scheduleIdle = () => {
		clearIdle();
		if (stopping || activeConnections !== 0 || inFlightRequests !== 0) return;
		idleTimer = setTimeout(() => void stop().catch(fail), idleMilliseconds());
	};
	const handle = async (socket: net.Socket, request: BrokerRequest, handshaken: { value: boolean }) => {
		inFlightRequests += 1;
		clearIdle();
		try {
			if (request.cmd === "hello") {
				const result: BrokerHandshake = {
					brokerVersion: BROKER_PROTOCOL_VERSION,
					helperProtocolVersion: helperProtocolVersion(),
					pid: process.pid,
				};
				handshaken.value = true;
				send(socket, { id: request.id, ok: true, result });
				return;
			}
			if (!handshaken.value) throw Object.assign(new Error("Broker handshake is required."), { code: "protocol_error" });
			if (request.cmd === "stop") {
				send(socket, { id: request.id, ok: true, result: { stopped: true, pid: process.pid } });
				socket.once("close", () => void stop().catch(fail));
				socket.end();
				return;
			}
			send(socket, { id: request.id, ok: true, result: await dispatchCommand(request) });
		} catch (error) {
			send(socket, { id: request.id, ok: false, error: brokerError(error) });
		} finally {
			inFlightRequests -= 1;
			scheduleIdle();
		}
	};

	server.on("connection", (socket) => {
		if (stopping) {
			socket.destroy();
			return;
		}
		clearIdle();
		activeConnections += 1;
		sockets.add(socket);
		socket.setEncoding("utf8");
		let buffer = "";
		const handshaken = { value: false };
		socket.on("data", (chunk: string) => {
			try {
				const decoded = decodeJsonLines(buffer + chunk);
				buffer = decoded.remainder;
				for (const value of decoded.values) {
					const request = parseBrokerRequest(value);
					if (!request) {
						send(socket, { id: "invalid", ok: false, error: { code: "invalid_request", message: "Broker request must contain id, cmd, and object args." } });
						continue;
					}
					void handle(socket, request, handshaken);
				}
			} catch (error) {
				send(socket, { id: "invalid", ok: false, error: brokerError(error) });
				socket.end();
			}
		});
		socket.on("error", () => undefined);
		socket.once("close", () => {
			sockets.delete(socket);
			activeConnections -= 1;
			scheduleIdle();
		});
	});

	try {
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => reject(error);
			server.once("error", onError);
			server.listen(BROKER_SOCKET_PATH, () => {
				server.removeListener("error", onError);
				resolve();
			});
		});
	} catch (error) {
		releaseStartupLock(startupLock);
		startupLock = undefined;
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EADDRINUSE" || code === "EEXIST") return;
		throw error;
	}
	if (BROKER_SOCKET_USES_FILESYSTEM) {
		try {
			chmodSync(BROKER_SOCKET_PATH, 0o600);
		} catch (error) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			unlinkBrokerSocket();
			releaseStartupLock(startupLock);
			startupLock = undefined;
			throw error;
		}
	}
	releaseStartupLock(startupLock);
	startupLock = undefined;
	server.on("error", (error) => void stop(error).catch(fail));
	signalReady();
	scheduleIdle();

	const onSignal = () => void stop().catch(fail);
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	try {
		await stopped;
	} finally {
		process.removeListener("SIGINT", onSignal);
		process.removeListener("SIGTERM", onSignal);
	}
}
