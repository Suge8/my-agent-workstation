import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { fileURLToPath } from "node:url";
import {
	BROKER_PROTOCOL_VERSION,
	BROKER_SOCKET_PATH,
	decodeJsonLines,
	parseBrokerResponse,
	type BrokerHandshake,
	type BrokerResponse,
} from "./ipc.ts";

interface PendingResponse {
	resolve(response: BrokerResponse): void;
	reject(error: Error): void;
}

export class BrokerCommandError extends Error {
	readonly code?: string;

	constructor(message: string, code?: string) {
		super(message);
		this.name = "BrokerCommandError";
		this.code = code;
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Operation aborted.");
}

function connectBroker(signal?: AbortSignal): Promise<net.Socket> {
	throwIfAborted(signal);
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(BROKER_SOCKET_PATH);
		const cleanup = () => signal?.removeEventListener("abort", onAbort);
		const fail = (error: Error) => {
			cleanup();
			socket.destroy();
			reject(error);
		};
		const onAbort = () => fail(new Error("Operation aborted."));
		socket.once("connect", () => {
			cleanup();
			socket.removeListener("error", fail);
			resolve(socket);
		});
		socket.once("error", fail);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function isMissingBroker(error: unknown): boolean {
	const code = error instanceof Error && "code" in error ? String(error.code) : "";
	return code === "ENOENT" || code === "ECONNREFUSED";
}

function brokerEntrypoint(): string {
	if (process.env.BCU_BROKER_ENTRY_PATH) return process.env.BCU_BROKER_ENTRY_PATH;
	const modulePath = fileURLToPath(import.meta.url);
	return modulePath.endsWith(".ts") ? fileURLToPath(new URL("./cli.ts", import.meta.url)) : modulePath;
}

async function startBroker(signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	const entrypoint = brokerEntrypoint();
	const child = spawn(process.execPath, [entrypoint, "__serve"], {
		detached: true,
		env: process.env,
		stdio: ["ignore", "ignore", "pipe", "pipe"],
	});
	let startupStderr = "";
	const stderr = child.stdio[2];
	stderr?.setEncoding("utf8");
	stderr?.on("data", (chunk: string) => { startupStderr += chunk; });
	const ready = child.stdio[3];
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			ready?.destroy();
			stderr?.destroy();
			child.unref();
			if (error) reject(error);
			else resolve();
		};
		const onAbort = () => finish(new Error("Operation aborted."));
		child.once("error", finish);
		child.once("exit", (code, childSignal) => {
			if (code === 0) finish();
			else finish(new Error(`bcu broker exited during startup (${childSignal ?? code ?? "unknown"})${startupStderr.trim() ? `: ${startupStderr.trim()}` : "."}`));
		});
		ready?.once("data", () => finish());
		ready?.once("error", finish);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function connectOrStart(signal?: AbortSignal): Promise<net.Socket> {
	try {
		return await connectBroker(signal);
	} catch (error) {
		if (!isMissingBroker(error)) throw error;
	}
	await startBroker(signal);
	return await connectBroker(signal);
}

class BrokerConnection {
	private buffer = "";
	private readonly pending = new Map<string, PendingResponse>();
	private closed = false;
	private readonly socket: net.Socket;

	constructor(socket: net.Socket) {
		this.socket = socket;
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => this.onData(chunk));
		socket.on("error", (error) => this.fail(error));
		socket.on("close", () => this.fail(new Error("bcu broker connection closed.")));
	}

	async call(command: string, args: object): Promise<unknown> {
		if (this.closed) throw new Error("bcu broker connection is closed.");
		const id = randomUUID();
		const response = await new Promise<BrokerResponse>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.socket.write(`${JSON.stringify({ id, cmd: command, args })}\n`, (error) => {
				if (!error) return;
				this.pending.delete(id);
				reject(error);
			});
		});
		if (!response.ok) throw new BrokerCommandError(response.error.message, response.error.code);
		return response.result;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.socket.end();
		this.rejectPending(new Error("bcu broker connection closed."));
	}

	private onData(chunk: string): void {
		try {
			const decoded = decodeJsonLines(this.buffer + chunk);
			this.buffer = decoded.remainder;
			for (const value of decoded.values) {
				const response = parseBrokerResponse(value);
				if (!response) throw new Error("bcu broker returned an invalid response.");
				const pending = this.pending.get(response.id);
				if (!pending) continue;
				this.pending.delete(response.id);
				pending.resolve(response);
			}
		} catch (error) {
			this.socket.destroy();
			this.fail(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private fail(error: Error): void {
		if (this.closed) return;
		this.closed = true;
		this.socket.destroy();
		this.rejectPending(error);
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}
}

async function connectAndHandshake(signal?: AbortSignal, start = true): Promise<{ connection: BrokerConnection; handshake: BrokerHandshake } | undefined> {
	let socket: net.Socket;
	try {
		socket = start ? await connectOrStart(signal) : await connectBroker(signal);
	} catch (error) {
		if (!start && isMissingBroker(error)) return undefined;
		throw error;
	}
	const connection = new BrokerConnection(socket);
	try {
		const result = await connection.call("hello", {});
		if (
			typeof result !== "object" || result === null
			|| (result as BrokerHandshake).brokerVersion !== BROKER_PROTOCOL_VERSION
			|| !Number.isInteger((result as BrokerHandshake).pid)
		) {
			throw new Error(`bcu broker protocol mismatch: expected ${BROKER_PROTOCOL_VERSION}.`);
		}
		return { connection, handshake: result as BrokerHandshake };
	} catch (error) {
		connection.close();
		throw error;
	}
}

export async function brokerHandshake(signal?: AbortSignal): Promise<BrokerHandshake> {
	const connected = await connectAndHandshake(signal);
	if (!connected) throw new Error("bcu broker is unavailable.");
	connected.connection.close();
	return connected.handshake;
}

export async function brokerHandshakeIfRunning(signal?: AbortSignal): Promise<BrokerHandshake | undefined> {
	const connected = await connectAndHandshake(signal, false);
	connected?.connection.close();
	return connected?.handshake;
}

async function call<Result>(connected: { connection: BrokerConnection }, command: string, args: object, signal?: AbortSignal): Promise<Result> {
	const { connection } = connected;
	const onAbort = () => connection.close();
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		throwIfAborted(signal);
		return await connection.call(command, args) as Result;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		connection.close();
	}
}

export async function requestBroker<Result>(command: string, args: object, signal?: AbortSignal): Promise<Result> {
	const connected = await connectAndHandshake(signal);
	if (!connected) throw new Error("bcu broker is unavailable.");
	return await call<Result>(connected, command, args, signal);
}

export async function requestRunningBroker<Result>(command: string, args: object, signal?: AbortSignal): Promise<Result | undefined> {
	const connected = await connectAndHandshake(signal, false);
	return connected ? await call<Result>(connected, command, args, signal) : undefined;
}
