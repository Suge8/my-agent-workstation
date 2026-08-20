import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOpenAINativeSettings, togglePriority } from "./config";

const temporaryDirectories: string[] = [];

function createConfig(config: Record<string, unknown>): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-openai-native-"));
	temporaryDirectories.push(directory);
	const configPath = join(directory, "config.json");
	writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
	return configPath;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("loads the extension-adjacent config", () => {
	const configPath = createConfig({
		nativeCompaction: false,
		providers: {
			"openai-codex": { textVerbosity: "low", priority: true },
		},
	});

	expect(loadOpenAINativeSettings(configPath)).toEqual({
		settings: {
			nativeCompaction: false,
			providers: {
				"openai-codex": { textVerbosity: "low", priority: true },
			},
		},
		warnings: [],
	});
});

test("fails closed when config is missing or invalid", () => {
	const configPath = createConfig({
		providers: {
			"openai-codex": { priority: "yes" },
		},
	});

	const loaded = loadOpenAINativeSettings(configPath);
	expect(loaded.settings.nativeCompaction).toBe(false);
	expect(loaded.settings.providers).toEqual({});
	expect(loaded.warnings).toEqual(["providers.openai-codex.priority: expected a boolean."]);

	const missing = loadOpenAINativeSettings(`${configPath}.missing`);
	expect(missing.settings).toEqual({ nativeCompaction: false, providers: {} });
	expect(missing.warnings[0]).toStartWith("config.json:");
});

test("toggles priority atomically in the extension config", () => {
	const configPath = createConfig({
		nativeCompaction: false,
		providers: {
			"openai-codex": { textVerbosity: "low", priority: true },
		},
	});

	const disabled = togglePriority("openai-codex", configPath);
	expect(disabled.enabled).toBe(false);
	expect(disabled.loaded.settings.providers["openai-codex"]).toEqual({ textVerbosity: "low" });

	const enabled = togglePriority("openai-codex", configPath);
	expect(enabled.enabled).toBe(true);
	expect(enabled.loaded.settings.providers["openai-codex"]).toEqual({
		textVerbosity: "low",
		priority: true,
	});

	expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
		nativeCompaction: false,
		providers: {
			"openai-codex": { textVerbosity: "low", priority: true },
		},
	});
});

test("toggles only the openai section of a firecode config", () => {
	const configPath = createConfig({
		keys: { rename: "ctrl+r" },
		presets: { sol: { model: "gpt-5.6-sol" } },
		openai: {
			nativeCompaction: false,
			providers: { "openai-codex": { textVerbosity: "low", priority: true } },
		},
	});

	const disabled = togglePriority("openai-codex", configPath);
	expect(disabled.enabled).toBe(false);
	expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
		keys: { rename: "ctrl+r" },
		presets: { sol: { model: "gpt-5.6-sol" } },
		openai: {
			nativeCompaction: false,
			providers: { "openai-codex": { textVerbosity: "low" } },
		},
	});
});

test("keeps comments outside the openai section when toggling fast", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-openai-native-"));
	temporaryDirectories.push(directory);
	const configPath = join(directory, "config.jsonc");
	writeFileSync(
		configPath,
		`{\n\t// keep me\n\t"keys": { "fast": "ctrl+f" },\n\t"openai": {\n\t\t"nativeCompaction": false,\n\t\t"providers": { "openai-codex": { "priority": true } }\n\t}\n}\n`,
	);

	togglePriority("openai-codex", configPath);
	expect(readFileSync(configPath, "utf8")).toContain("// keep me");
});
