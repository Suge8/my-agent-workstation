import { chmod, mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ScreenshotArtifact, ToolResult } from "./contract.ts";

const ARTIFACT_TTL_MS = 10 * 60 * 1_000;
const MAX_ARTIFACTS = 128;
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;
const directoryTails = new Map<string, Promise<unknown>>();

export function screenshotDirectory(platform: NodeJS.Platform = process.platform): string {
	if (platform === "win32") return path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "bcu", "shots");
	return path.join(os.homedir(), "Library", "Caches", "bcu", "shots");
}

function captureDetails(details: unknown): { stateId: string; width: number; height: number } | undefined {
	if (!details || typeof details !== "object") return undefined;
	const record = details as Record<string, unknown>;
	const capture = record.capture && typeof record.capture === "object"
		? record.capture as Record<string, unknown>
		: record;
	if (typeof capture.stateId !== "string" || !/^[A-Za-z0-9_-]+$/.test(capture.stateId)) return undefined;
	return {
		stateId: capture.stateId,
		width: typeof capture.width === "number" ? capture.width : 0,
		height: typeof capture.height === "number" ? capture.height : 0,
	};
}

async function remove(filePath: string): Promise<void> {
	await unlink(filePath).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
}

interface ArtifactFile {
	path: string;
	size: number;
	mtimeMs: number;
}

async function artifactFile(filePath: string): Promise<ArtifactFile | undefined> {
	try {
		const metadata = await stat(filePath);
		return { path: filePath, size: metadata.size, mtimeMs: metadata.mtimeMs };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function prune(directory: string, preservedPath: string, now = Date.now()): Promise<void> {
	const entries = await readdir(directory, { withFileTypes: true });
	const candidates = await Promise.all(entries
		.filter((entry) => entry.isFile() && /\.(jpg|png)$/.test(entry.name))
		.map(async (entry) => await artifactFile(path.join(directory, entry.name))));
	const files = candidates
		.filter((file): file is ArtifactFile => file !== undefined)
		.sort((left, right) => left.mtimeMs - right.mtimeMs);
	let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
	let totalFiles = files.length;
	for (const file of files) {
		const expired = now - file.mtimeMs > ARTIFACT_TTL_MS;
		const overCapacity = totalFiles > MAX_ARTIFACTS || totalBytes > MAX_ARTIFACT_BYTES;
		if (file.path === preservedPath || (!expired && !overCapacity)) continue;
		await remove(file.path);
		totalBytes -= file.size;
		totalFiles -= 1;
	}
}

async function serializeDirectory<Result>(directory: string, work: () => Promise<Result>): Promise<Result> {
	const previous = directoryTails.get(directory) ?? Promise.resolve();
	const current = previous.catch(() => undefined).then(work);
	directoryTails.set(directory, current);
	try {
		return await current;
	} finally {
		if (directoryTails.get(directory) === current) directoryTails.delete(directory);
	}
}

export async function materializeScreenshot<Details>(
	result: ToolResult<Details>,
	directory = screenshotDirectory(),
): Promise<ToolResult<Details>> {
	const image = result.image;
	if (!image) return result;
	const capture = captureDetails(result.details);
	if (!capture) throw Object.assign(new Error("Screenshot result is missing a valid stateId and dimensions."), { code: "internal_error" });
	const bytes = Buffer.from(image.data, "base64");
	if (bytes.length === 0 || bytes.length > MAX_SCREENSHOT_BYTES) {
		throw Object.assign(new Error(`Screenshot size ${bytes.length} is outside the supported range.`), { code: "internal_error" });
	}
	const artifactDirectory = path.resolve(directory);
	return await serializeDirectory(artifactDirectory, async () => {
		await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
		if (process.platform !== "win32") await chmod(artifactDirectory, 0o700);
		const extension = image.mimeType === "image/png" ? "png" : "jpg";
		const filePath = path.join(artifactDirectory, `${capture.stateId}.${extension}`);
		await writeFile(filePath, bytes, { mode: 0o600 });
		if (process.platform !== "win32") await chmod(filePath, 0o600);
		await prune(artifactDirectory, filePath);
		const screenshot: ScreenshotArtifact = {
			path: filePath,
			mimeType: image.mimeType,
			width: capture.width,
			height: capture.height,
		};
		return { text: result.text, details: result.details, screenshot };
	});
}
