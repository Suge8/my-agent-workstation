import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { expect, test } from "bun:test";
import { FIRECODE_DIR } from "./loader.ts";

const transpiler = new Bun.Transpiler({ loader: "ts" });

function resolveImport(importer: string, specifier: string): string {
	const target = resolve(dirname(importer), specifier);
	const candidates = extname(target)
		? [target, target.replace(/\.js$/, ".ts")]
		: [target, `${target}.ts`, join(target, "index.ts")];
	const resolved = candidates.find(existsSync);
	if (!resolved || !resolved.startsWith(`${FIRECODE_DIR}${sep}`))
		throw new Error(`无法解析本地运行时 import：${relative(FIRECODE_DIR, importer)} → ${specifier}`);
	return resolved;
}

async function runtimeClosure(entries: string[]): Promise<string[]> {
	const pending = entries.map((entry) => resolve(FIRECODE_DIR, entry));
	const visited = new Set<string>();
	while (pending.length > 0) {
		const path = pending.pop()!;
		if (visited.has(path)) continue;
		visited.add(path);
		const source = await readFile(path, "utf8");
		for (const { path: specifier } of transpiler.scan(source).imports)
			if (specifier.startsWith(".")) pending.push(resolveImport(path, specifier));
	}
	return [...visited].map((path) => relative(FIRECODE_DIR, path).split(sep).join("/")).sort();
}

test("npm pack contains the complete local runtime import closure", async () => {
	const manifest = await Bun.file(join(FIRECODE_DIR, "package.json")).json();
	const pack = Bun.spawnSync(["npm", "pack", "--dry-run", "--json", "--ignore-scripts"], {
		cwd: FIRECODE_DIR,
		stderr: "pipe",
		stdout: "pipe",
	});
	if (pack.exitCode !== 0) throw new Error(pack.stderr.toString());
	const packed = new Set(
		(JSON.parse(pack.stdout.toString())[0].files as Array<{ path: string }>).map(({ path }) => path),
	);
	const closure = await runtimeClosure(manifest.pi.extensions);

	expect(closure.filter((path) => !packed.has(path))).toEqual([]);
});
