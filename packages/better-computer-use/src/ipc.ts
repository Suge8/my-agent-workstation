import os from "node:os";
import path from "node:path";

export const BROKER_PROTOCOL_VERSION = 1;

export function defaultBrokerSocketPath(_platform: NodeJS.Platform = process.platform, homeDirectory = os.homedir()): string {
	return path.join(homeDirectory, "Library", "Caches", "bcu", "broker.sock");
}

export function brokerSocketUsesFilesystem(_platform: NodeJS.Platform = process.platform): true {
	return true;
}

export const BROKER_SOCKET_PATH = process.env.BCU_BROKER_SOCKET_PATH ?? defaultBrokerSocketPath();
export const BROKER_SOCKET_USES_FILESYSTEM = brokerSocketUsesFilesystem();

export interface BrokerRequest {
	id: string;
	cmd: string;
	args: Record<string, unknown>;
}

export interface BrokerError {
	message: string;
	code?: string;
}

export type BrokerResponse =
	| { id: string; ok: true; result: unknown }
	| { id: string; ok: false; error: BrokerError };

export interface BrokerHandshake {
	brokerVersion: number;
	helperProtocolVersion: number | null;
	pid: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseBrokerRequest(value: unknown): BrokerRequest | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.cmd !== "string" || !isRecord(value.args)) return undefined;
	return { id: value.id, cmd: value.cmd, args: value.args };
}

export function parseBrokerResponse(value: unknown): BrokerResponse | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.ok !== "boolean") return undefined;
	if (value.ok === true && "result" in value) return { id: value.id, ok: true, result: value.result };
	if (value.ok !== false || !isRecord(value.error) || typeof value.error.message !== "string") return undefined;
	return {
		id: value.id,
		ok: false,
		error: {
			message: value.error.message,
			code: typeof value.error.code === "string" ? value.error.code : undefined,
		},
	};
}

export function decodeJsonLines(buffer: string): { values: unknown[]; remainder: string } {
	const values: unknown[] = [];
	let newline = buffer.indexOf("\n");
	while (newline >= 0) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		if (line) values.push(JSON.parse(line));
		newline = buffer.indexOf("\n");
	}
	return { values, remainder: buffer };
}
