/**
 * herdr socket 短连接客户端：单请求单连接，只有 herdr 返回 result 才算送达。
 * herdr-display（身份投影）与 review（占用 state_label）共用；herdr 之外返回未送达。
 */
import net from "node:net";

const REQUEST_TIMEOUT_MS = 500;

export interface HerdrPaneEnv {
	paneId: string;
	socketPath: string;
}

export function herdrPaneEnv(): HerdrPaneEnv | undefined {
	const paneId = process.env.HERDR_PANE_ID;
	const socketPath = process.env.HERDR_SOCKET_PATH;
	if (process.env.HERDR_ENV !== "1" || !paneId || !socketPath) return undefined;
	return { paneId, socketPath };
}

export function herdrRequest(
	source: string,
	method: string,
	params: Record<string, unknown>,
): Promise<boolean> {
	const env = herdrPaneEnv();
	if (!env) return Promise.resolve(false);
	const endpoint =
		process.platform === "win32" ? `\\\\.\\pipe\\${env.socketPath}` : env.socketPath;
	return new Promise((resolve) => {
		const socket = net.createConnection(endpoint);
		let buffer = "";
		const finish = (delivered: boolean) => {
			clearTimeout(timer);
			socket.destroy();
			resolve(delivered);
		};
		const timer = setTimeout(() => finish(false), REQUEST_TIMEOUT_MS);
		timer.unref?.();
		socket.on("error", () => finish(false));
		socket.on("end", () => finish(false));
		socket.on("data", (chunk) => {
			buffer += chunk;
			const end = buffer.indexOf("\n");
			if (end >= 0) finish(hasResult(buffer.slice(0, end)));
		});
		socket.on("connect", () => {
			socket.write(`${JSON.stringify({ id: source, method, params })}\n`);
		});
	});
}

function hasResult(line: string): boolean {
	try {
		const response = JSON.parse(line) as { result?: unknown; error?: unknown };
		return !response.error && typeof response.result === "object" && response.result !== null;
	} catch {
		return false;
	}
}
