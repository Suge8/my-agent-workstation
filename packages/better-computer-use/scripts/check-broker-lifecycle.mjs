#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { npmInvocation } from "./npm-invocation.mjs";

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(root, "dist", "bcu.mjs");
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bcu-broker-lifecycle-"));
const livePids = new Set();

function timeout(description, milliseconds) {
	return new Promise((_, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}.`)), milliseconds);
		timer.unref?.();
	});
}

function isolatedSocketPath(directory) {
	return path.join(directory, "broker.sock");
}

function connect(socketPath) {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		socket.once("connect", () => { socket.destroy(); resolve(); });
		socket.once("error", reject);
	});
}

function environment(socketPath, idleMs) {
	return {
		...process.env,
		BCU_BROKER_SOCKET_PATH: socketPath,
		BCU_IDLE_MS: String(idleMs),
	};
}

async function request(env, command = "ping", args = {}) {
	const { stdout } = await execFile(process.execPath, [bundle, "__request", command, JSON.stringify(args)], {
		cwd: root,
		env,
		maxBuffer: 4 * 1024 * 1024,
	});
	return JSON.parse(stdout);
}

function kill(pid, signal = "SIGKILL") {
	try {
		process.kill(pid, signal);
		livePids.delete(pid);
	} catch (error) {
		if (error?.code !== "ESRCH") throw error;
	}
}

async function sourceAgentStart() {
	const directory = path.join(temporaryRoot, "source-agent");
	await fs.mkdir(directory);
	const socketPath = isolatedSocketPath(directory);
	const env = environment(socketPath, 60_000);
	const clientUrl = pathToFileURL(path.join(root, "src", "client.ts")).href;
	const source = `import { requestBroker } from ${JSON.stringify(clientUrl)}; console.log(JSON.stringify(await requestBroker("ping", {})))`;
	const { stdout } = await execFile(process.execPath, ["--input-type=module", "-e", source], { cwd: root, env });
	const reply = JSON.parse(stdout);
	assert(Number.isInteger(reply.pid), "source agent did not start a broker");
	livePids.add(reply.pid);
	kill(reply.pid);
	console.log(`PASS source agent started broker ${reply.pid} through client.ts`);
}

async function concurrentStartAndRecovery() {
	const directory = path.join(temporaryRoot, "race");
	await fs.mkdir(directory);
	const socketPath = isolatedSocketPath(directory);
	const env = environment(socketPath, 60_000);
	const replies = await Promise.all(Array.from({ length: 20 }, () => request(env)));
	const pids = new Set(replies.map((reply) => reply.pid));
	assert.equal(pids.size, 1, `concurrent clients started multiple brokers: ${[...pids].join(", ")}`);
	const [pid] = pids;
	livePids.add(pid);
	assert.equal((await fs.stat(directory)).mode & 0o777, 0o700, "broker cache directory is not mode 0700");
	assert.equal((await fs.stat(socketPath)).mode & 0o777, 0o600, "broker socket is not mode 0600");

	const monitor = net.createConnection(socketPath);
	monitor.on("error", () => undefined);
	await once(monitor, "connect");
	const closed = once(monitor, "close");
	kill(pid);
	await Promise.race([closed, timeout("killed broker connection to close", 5_000)]);

	await fs.stat(socketPath);
	const recoveredReplies = await Promise.all(Array.from({ length: 30 }, () => request(env)));
	const recoveredPids = new Set(recoveredReplies.map((reply) => reply.pid));
	assert.equal(recoveredPids.size, 1, `stale cleanup split clients across brokers: ${[...recoveredPids].join(", ")}`);
	const [recoveredPid] = recoveredPids;
	assert.notEqual(recoveredPid, pid, "clients reused the killed broker pid");
	livePids.add(recoveredPid);
	kill(recoveredPid);
	console.log(`PASS 20 clients shared broker ${pid}; 30 stale-socket clients recovered as ${recoveredPid}`);
}

async function idleExit() {
	const directory = path.join(temporaryRoot, "idle");
	await fs.mkdir(directory);
	const socketPath = isolatedSocketPath(directory);
	const env = environment(socketPath, 2_000);
	const broker = spawn(process.execPath, [bundle, "__serve"], {
		cwd: root,
		env,
		stdio: ["ignore", "ignore", "pipe", "pipe"],
	});
	let stderr = "";
	broker.stderr.setEncoding("utf8");
	broker.stderr.on("data", (chunk) => { stderr += chunk; });
	const ready = broker.stdio[3];
	await Promise.race([
		once(ready, "data"),
		once(broker, "exit").then(([code, signal]) => { throw new Error(`Idle broker exited before ready (${signal ?? code}): ${stderr.trim()}`); }),
		timeout("idle broker readiness", 5_000),
	]);
	const reply = await request(env);
	assert.equal(reply.pid, broker.pid, "request did not connect to the directly started idle broker");
	const [code, signal] = await Promise.race([once(broker, "exit"), timeout("idle broker exit", 8_000)]);
	assert.equal(signal, null, `idle broker exited by signal ${signal}`);
	assert.equal(code, 0, `idle broker exited ${code}: ${stderr.trim()}`);
	await assert.rejects(fs.stat(socketPath), (error) => error?.code === "ENOENT", "idle broker left its socket behind");
	console.log("PASS broker exited after BCU_IDLE_MS=2000 without polling");
}

try {
	const [npm, npmArgs] = npmInvocation(["run", "build", "--silent"]);
	await execFile(npm, npmArgs, { cwd: root });
	await sourceAgentStart();
	await concurrentStartAndRecovery();
	await idleExit();
} finally {
	for (const pid of livePids) kill(pid);
	await fs.rm(temporaryRoot, { recursive: true, force: true });
}
