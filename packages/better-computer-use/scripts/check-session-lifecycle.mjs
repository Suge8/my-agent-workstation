import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { cdpTabForWindow } from "../src/cdp.ts";
import { shutdownComputerUseSession } from "../src/bridge.ts";

function websocketFrame(value, opcode = 1) {
	const payload = Buffer.from(value);
	assert(payload.length < 126, "test frame unexpectedly large");
	return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}

function serveWebsocket(socket) {
	let buffer = Buffer.alloc(0);
	socket.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		while (buffer.length >= 2) {
			const opcode = buffer[0] & 0x0f;
			const masked = (buffer[1] & 0x80) !== 0;
			let length = buffer[1] & 0x7f;
			let offset = 2;
			if (length === 126) {
				if (buffer.length < 4) return;
				length = buffer.readUInt16BE(2);
				offset = 4;
			}
			const maskLength = masked ? 4 : 0;
			if (buffer.length < offset + maskLength + length) return;
			const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
			offset += maskLength;
			const payload = Buffer.from(buffer.subarray(offset, offset + length));
			buffer = buffer.subarray(offset + length);
			if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];

			if (opcode === 8) {
				socket.end(websocketFrame(payload, 8));
				continue;
			}
			if (opcode !== 1) continue;
			const request = JSON.parse(payload.toString("utf8"));
			socket.write(websocketFrame(JSON.stringify({ id: request.id, result: {} })));
		}
	});
}

const sockets = new Set();
let upgradedSocket;
let port;
const server = http.createServer((request, response) => {
	if (request.url === "/json/list") {
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify([{
			id: "test-tab",
			type: "page",
			title: "Test Tab",
			url: "about:blank",
			webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/test-tab`,
		}]));
		return;
	}
	response.statusCode = 404;
	response.end();
});

server.on("connection", (socket) => {
	sockets.add(socket);
	socket.on("close", () => sockets.delete(socket));
});
server.on("upgrade", (request, socket) => {
	upgradedSocket = socket;
	const accept = createHash("sha1")
		.update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
		.digest("base64");
	socket.write([
		"HTTP/1.1 101 Switching Protocols",
		"Upgrade: websocket",
		"Connection: Upgrade",
		`Sec-WebSocket-Accept: ${accept}`,
		"",
		"",
	].join("\r\n"));
	serveWebsocket(socket);
});

try {
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	port = server.address().port;
	process.env.BCU_CDP_PORT = String(port);

	const tab = await cdpTabForWindow("Test Tab");
	assert(tab?.isOpen, "test CDP tab did not connect");
	const websocket = upgradedSocket;
	assert(websocket, "test server did not retain the CDP socket");

	await shutdownComputerUseSession();
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("CDP socket remained open after session shutdown")), 1_500);
		websocket.once("close", () => {
			clearTimeout(timer);
			resolve();
		});
	});

	const response = await fetch(`http://127.0.0.1:${port}/json/list`);
	assert.equal(response.status, 200, "session shutdown stopped the external browser endpoint");
	assert.equal(process.env.BCU_CDP_PORT, String(port), "session shutdown changed the external CDP configuration");
	console.log("PASS session shutdown closes CDP while leaving an external browser running");
} finally {
	delete process.env.BCU_CDP_PORT;
	for (const socket of sockets) socket.destroy();
	await new Promise((resolve) => server.close(resolve));
}
