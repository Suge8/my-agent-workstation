#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bcu-helper-transport-"));
const socketPath = path.join(temporaryRoot, "helper.sock");
process.env.BCU_SOCKET_PATH = socketPath;
const { HelperTransportError, MacosHelperClient } = await import("../src/platform/macos/helper.ts");

let connectionCount = 0;
let bufferedDropRequests = 0;
let closeAfterShutdown = false;
const serverSockets = new Set();
const server = net.createServer((socket) => {
	connectionCount += 1;
	serverSockets.add(socket);
	socket.on("close", () => serverSockets.delete(socket));
	socket.setEncoding("utf8");
	let buffer = "";
	const outOfOrder = [];
	socket.on("data", (chunk) => {
		buffer += chunk;
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			const request = JSON.parse(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);
			if (request.cmd === "shutdown" && closeAfterShutdown) {
				socket.write(`${JSON.stringify({ id: request.id, ok: true, result: { shuttingDown: true } })}\n`);
				setImmediate(() => socket.destroy());
				continue;
			}
			if (request.cmd === "first" || request.cmd === "second") {
				outOfOrder.push(request);
				if (outOfOrder.length === 2) {
					for (const pending of [...outOfOrder].reverse()) {
						socket.write(`${JSON.stringify({ id: pending.id, ok: true, result: pending.cmd })}\n`);
					}
				}
				continue;
			}
			if (request.cmd.startsWith("drop-")) {
				bufferedDropRequests += 1;
				if (bufferedDropRequests === 2) socket.destroy();
				continue;
			}
			socket.write(`${JSON.stringify({ id: request.id, ok: true, result: request.cmd })}\n`);
		}
	});
});

async function startServer() {
	if (server.listening) return;
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
}

class EventDrivenHelper extends MacosHelperClient {
	attempts = 0;
	launches = 0;

	async daemonCommand(...args) {
		this.attempts += 1;
		return await super.daemonCommand(...args);
	}

	async launchDaemon() {
		this.launches += 1;
		await startServer();
	}
}

const eventHelper = new EventDrivenHelper();
assert.equal(await eventHelper.ensureDaemon(), true, "helper did not connect when the socket creation event arrived");
assert.equal(eventHelper.launches, 1, "helper launch was not requested exactly once");
assert.equal(eventHelper.attempts, 2, "helper made periodic connection attempts instead of one initial and one event-driven attempt");
eventHelper.dispose();
connectionCount = 0;

const helper = new MacosHelperClient();
try {
	const [first, second] = await Promise.all([
		helper.daemonCommand("first", {}, 1_000),
		helper.daemonCommand("second", {}, 1_000),
	]);
	assert.deepEqual([first, second], ["first", "second"], "pending ids did not correlate out-of-order responses");
	assert.equal(connectionCount, 1, "concurrent commands opened more than one helper connection");

	const dropped = await Promise.allSettled([
		helper.daemonCommand("drop-one", {}, 1_000),
		helper.daemonCommand("drop-two", {}, 1_000),
	]);
	assert(dropped.every((result) => result.status === "rejected" && result.reason instanceof HelperTransportError), "disconnect did not reject every pending helper command");
	assert.equal(await helper.daemonCommand("recovered", {}, 1_000), "recovered", "command did not reconnect after helper disconnect");
	assert.equal(connectionCount, 2, "helper reconnect did not create exactly one successor connection");
	closeAfterShutdown = true;
	await helper.restart();
	assert.equal(connectionCount, 3, "helper restart did not reconnect after the old socket close event");
	console.log("PASS macOS helper startup/restart is event-driven and its persistent connection recovers safely");
} finally {
	helper.dispose();
	for (const socket of serverSockets) socket.destroy();
	await new Promise((resolve) => server.close(resolve));
	await fs.rm(temporaryRoot, { recursive: true, force: true });
}
