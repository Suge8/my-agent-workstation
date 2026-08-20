#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { waitForCdpReady, waitForPathReady } from "../src/readiness.ts";

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bcu-event-readiness-"));
try {
	const marker = path.join(temporaryRoot, "socket-ready");
	let eventChecks = 0;
	await waitForPathReady(
		marker,
		() => { setImmediate(() => void fs.writeFile(marker, "ready")); },
		async () => {
			eventChecks += 1;
			try { await fs.access(marker); return true; } catch { return false; }
		},
		{ timeoutMs: 1_000, description: "event-created readiness marker" },
	);
	assert(eventChecks >= 2 && eventChecks <= 3, `path readiness made unexpected checks without events: ${eventChecks}`);

	const absent = path.join(temporaryRoot, "never-ready");
	let idleChecks = 0;
	await assert.rejects(
		waitForPathReady(
			absent,
			() => undefined,
			() => { idleChecks += 1; return false; },
			{ timeoutMs: 50, description: "absent readiness marker" },
		),
		/Timed out waiting for absent readiness marker/,
	);
	assert.equal(idleChecks, 2, "path readiness periodically rechecked without a filesystem event");

	const port = 43210;
	const child = spawn(process.execPath, ["-e", `setImmediate(() => console.error('DevTools listening on ws://127.0.0.1:${port}/devtools/browser/test'))`], {
		stdio: ["ignore", "ignore", "pipe"],
	});
	const exited = once(child, "exit");
	await waitForCdpReady(child, port, { timeoutMs: 1_000, description: "fake CDP stderr event" });
	const [code] = await exited;
	assert.equal(code, 0, "fake CDP process failed");
	console.log("PASS readiness waits only on filesystem and child stderr events");
} finally {
	await fs.rm(temporaryRoot, { recursive: true, force: true });
}
