#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderModelProfile, parseJsonc } from "./render-model-profile.mjs";

function args(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (!flag?.startsWith("--") || value === undefined) throw new Error(`参数无效：${flag ?? ""}`);
		options[flag.slice(2)] = value;
	}
	const required = options.mode === "restore"
		? ["pi-settings", "pi-keybindings", "pi-settings-backup", "pi-keybindings-backup", "ownership"]
		: ["profile", "pi-settings", "pi-keybindings", "firecode", "ownership"];
	for (const name of required) if (!options[name]) throw new Error(`缺少 --${name}`);
	return options;
}

async function readObject(path, jsonc = false) {
	try {
		const text = await readFile(path, "utf8");
		const value = jsonc ? parseJsonc(text) : JSON.parse(text);
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} 必须是对象`);
		return value;
	} catch (error) {
		if (error?.code === "ENOENT") return {};
		throw error;
	}
}

async function atomicJson(path, value) {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, path);
}

async function writeRestored(path, value, absentBeforeInstall) {
	if (absentBeforeInstall && Object.keys(value).length === 0) {
		await rm(path, { force: true });
		return;
	}
	await atomicJson(path, value);
}

function restoreKeys(current, baseline, keys) {
	const restored = { ...current };
	for (const key of keys) {
		if (Object.hasOwn(baseline, key)) restored[key] = baseline[key];
		else delete restored[key];
	}
	return restored;
}

function restoreSettings(current, baseline, managed) {
	const topLevel = managed.filter((key) => !key.includes("."));
	const restored = restoreKeys(current, baseline, topLevel);
	if (managed.includes("warnings.anthropicExtraUsage")) {
		const warnings = restoreKeys(restored.warnings ?? {}, baseline.warnings ?? {}, ["anthropicExtraUsage"]);
		if (Object.keys(warnings).length) restored.warnings = warnings;
		else delete restored.warnings;
	}
	return restored;
}

export async function restore(options) {
	const ownershipPath = resolve(options.ownership);
	if (!existsSync(ownershipPath)) throw new Error("Pi 配置接管清单缺失；已保留 backups，请恢复清单或手动回退");
	const settingsPath = resolve(options["pi-settings"]);
	const keybindingsPath = resolve(options["pi-keybindings"]);
	const settingsBackup = resolve(options["pi-settings-backup"]);
	const keybindingsBackup = resolve(options["pi-keybindings-backup"]);
	const [settings, keybindings, baselineSettings, baselineKeybindings, ownership] = await Promise.all([
		readObject(settingsPath),
		readObject(keybindingsPath),
		readObject(settingsBackup),
		readObject(keybindingsBackup),
		readObject(ownershipPath),
	]);
	const restoredSettings = restoreSettings(settings, baselineSettings, ownership.settings ?? []);
	const restoredKeybindings = restoreKeys(keybindings, baselineKeybindings, ownership.keybindings ?? []);
	await Promise.all([
		writeRestored(settingsPath, restoredSettings, existsSync(`${settingsBackup}.absent`)),
		writeRestored(keybindingsPath, restoredKeybindings, existsSync(`${keybindingsBackup}.absent`)),
	]);
}

function modelRef(model) {
	return `${model.provider}/${model.model}`;
}

const FIRECODE_OPENAI_DEFAULTS = {
	nativeCompaction: true,
	providers: {
		"openai-codex": { textVerbosity: "low", priority: true },
		xai: { priority: true },
	},
};

function baseConfiguration(profile, providers, settings, keybindings, firecode) {
	const providerSet = new Set(providers);
	const currentOpenAI = firecode.openai ?? {};
	return {
		piSettings: {
			...settings,
			warnings: { ...(settings.warnings ?? {}), anthropicExtraUsage: false },
		},
		piKeybindings: { ...keybindings, ...profile.keybindings },
		firecode: {
			...firecode,
			openai: {
				...FIRECODE_OPENAI_DEFAULTS,
				...currentOpenAI,
				providers: { ...FIRECODE_OPENAI_DEFAULTS.providers, ...(currentOpenAI.providers ?? {}) },
			},
			features: {
				...(firecode.features ?? {}),
				header: true,
				statusbar: true,
				tools: true,
				presets: false,
				rename: true,
				stats: true,
				claudeSub: providerSet.has("anthropic"),
				openaiNative: providerSet.has("openai-codex") || providerSet.has("xai"),
				workingFlame: true,
				bark: false,
				review: false,
				master: false,
			},
			keys: { ...(firecode.keys ?? {}), ...profile.firecodeKeys },
		},
	};
}

function automaticSelections(profile, providers, available, supplied) {
	const providerSet = new Set(providers);
	const availableSet = new Set(available);
	const selected = { ...supplied, models: { ...(supplied.models ?? {}) } };
	for (const [alias, model] of Object.entries(profile.models)) {
		if (Object.hasOwn(selected.models, alias)) continue;
		if (!providerSet.has(model.provider) || !availableSet.has(modelRef(model))) selected.models[alias] = null;
	}
	const defaultModel = profile.models[profile.default];
	const defaultRef = defaultModel && modelRef(defaultModel);
	if (!selected.default && (selected.models[profile.default] === null || !availableSet.has(defaultRef))) {
		const fallback = profile.cycle
			.map((alias) => profile.models[alias])
			.find((model) => model && providerSet.has(model.provider) && availableSet.has(modelRef(model)));
		if (fallback) selected.default = modelRef(fallback);
	}
	return selected;
}

export async function configure(options) {
	const profilePath = resolve(options.profile);
	const settingsPath = resolve(options["pi-settings"]);
	const keybindingsPath = resolve(options["pi-keybindings"]);
	const firecodePath = resolve(options.firecode);
	const [profile, settings, keybindings, firecode, supplied] = await Promise.all([
		readObject(profilePath),
		readObject(settingsPath),
		readObject(keybindingsPath),
		readObject(firecodePath, true),
		options.selections ? readObject(resolve(options.selections)) : {},
	]);
	const providers = (options.providers ?? "").split(",").filter(Boolean);
	const available = (options["available-models"] ?? "").split(",").filter(Boolean);
	const base = baseConfiguration(profile, providers, settings, keybindings, firecode);
	base.firecode.features.bark = existsSync(resolve(dirname(settingsPath), "bark-key"));
	let rendered = base;
	let managesModels = false;
	if (providers.length && available.length) {
		const selections = automaticSelections(profile, providers, available, supplied);
		const defaultDisabled = selections.models?.[profile.default] === null && !selections.default;
		if (!defaultDisabled) {
			managesModels = true;
			rendered = renderModelProfile({
				profile,
				authenticatedProviders: providers,
				availableModels: available,
				selections,
				piSettings: base.piSettings,
				piKeybindings: base.piKeybindings,
				firecode: base.firecode,
			});
		}
	}
	const ownershipPath = resolve(options.ownership);
	const previousOwnership = await readObject(ownershipPath);
	const managedSettings = new Set(previousOwnership.settings ?? []);
	managedSettings.add("warnings.anthropicExtraUsage");
	if (managesModels) {
		for (const key of ["defaultProvider", "defaultModel", "defaultThinkingLevel", "enabledModels"]) managedSettings.add(key);
	}
	const managedKeybindings = new Set(previousOwnership.keybindings ?? []);
	for (const key of Object.keys(profile.keybindings)) managedKeybindings.add(key);
	await Promise.all([
		atomicJson(settingsPath, rendered.piSettings),
		atomicJson(keybindingsPath, rendered.piKeybindings),
		atomicJson(firecodePath, rendered.firecode),
		atomicJson(ownershipPath, { settings: [...managedSettings], keybindings: [...managedKeybindings] }),
	]);
	return { configuredModels: rendered.piSettings.enabledModels?.length ?? 0, providers };
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
	const options = args(process.argv.slice(2));
	const operation = options.mode === "restore" ? restore(options) : configure(options);
	operation
		.then((result) => process.stdout.write(`${JSON.stringify(result ?? { restored: true })}\n`))
		.catch((error) => {
			process.stderr.write(`${error.message}\n`);
			process.exitCode = 1;
		});
}
