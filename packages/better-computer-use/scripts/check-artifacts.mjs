#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { materializeScreenshot } from "../src/artifacts.ts";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bcu-artifacts-"));
const jpegBytes = Buffer.from("test-jpeg-bytes");
const stateId = "state-artifact-test";
try {
	const result = await materializeScreenshot({
		text: "Observed fixture.",
		details: { capture: { stateId, width: 800, height: 600 } },
		image: { data: jpegBytes.toString("base64"), mimeType: "image/jpeg" },
	}, directory);
	assert.equal(result.image, undefined, "materialized result retained base64 image data");
	assert.deepEqual(result.screenshot, {
		path: path.join(directory, `${stateId}.jpg`),
		mimeType: "image/jpeg",
		width: 800,
		height: 600,
	});
	assert.deepEqual(await fs.readFile(result.screenshot.path), jpegBytes, "artifact bytes changed on disk");
	assert.equal((await fs.stat(result.screenshot.path)).mode & 0o777, 0o600, "screenshot artifact is not mode 0600");
	assert.equal((await fs.stat(directory)).mode & 0o777, 0o700, "screenshot directory is not mode 0700");
	assert(!JSON.stringify(result).includes(jpegBytes.toString("base64")), "base64 image leaked into the broker result");

	await fs.rm(directory, { recursive: true, force: true });
	await fs.mkdir(directory, { mode: 0o700 });
	await Promise.all(Array.from({ length: 128 }, async (_, index) => {
		await fs.writeFile(path.join(directory, `old-${index}.jpg`), jpegBytes, { mode: 0o600 });
	}));
	const concurrent = await Promise.allSettled(Array.from({ length: 160 }, (_, index) => materializeScreenshot({
		text: "Concurrent fixture.",
		details: { capture: { stateId: `concurrent-${index}`, width: 80, height: 60 } },
		image: { data: jpegBytes.toString("base64"), mimeType: "image/jpeg" },
	}, directory)));
	const rejected = concurrent.filter((outcome) => outcome.status === "rejected");
	assert.deepEqual(rejected, [], `concurrent artifact writes failed: ${rejected.map((outcome) => outcome.reason).join("; ")}`);
	const files = await fs.readdir(directory);
	assert(files.length <= 128, `artifact count exceeded capacity: ${files.length}`);
	const stats = await Promise.all(files.map((file) => fs.stat(path.join(directory, file))));
	assert(stats.reduce((sum, file) => sum + file.size, 0) <= 256 * 1024 * 1024, "artifact bytes exceeded capacity");
	assert(stats.every((file) => (file.mode & 0o777) === 0o600), "a concurrent screenshot is not mode 0600");
	console.log("Screenshot artifact checks passed, including 160 writes at capacity.");
} finally {
	await fs.rm(directory, { recursive: true, force: true });
}
