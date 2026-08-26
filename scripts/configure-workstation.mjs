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
	const required = options.mode === "validate"
		? ["ownership"]
		: options.mode === "restore"
			? ["pi-settings", "pi-keybindings", "pi-settings-backup", "pi-keybindings-backup", "firecode", "ownership"]
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

const FIRECODE_PATHS = [
	...["header", "statusbar", "tools", "presets", "rename", "stats", "claudeSub", "openaiNative", "workingFlame", "bark", "review", "master", "watcher"].map((name) => ["features", name]),
	["openai", "nativeCompaction"], ["openai", "providers", "openai-codex", "textVerbosity"], ["openai", "providers", "openai-codex", "priority"], ["openai", "providers", "xai", "priority"],
	["keys", "rename"], ["keys", "cyclePreset"], ["keys", "fast"], ["master", "models"], ["review", "advisor"], ["review", "reviewers"],
	["watcher", "enabled"], ["watcher", "model"], ["watcher", "thinking"], ["watcher", "context"],
];

function valueAt(object, path) {
	let value = object;
	for (const key of path) {
		if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return { exists: false };
		value = value[key];
	}
	return { exists: true, value };
}

function same(left, right) {
	return left.exists === right.exists && (!left.exists || JSON.stringify(left.value) === JSON.stringify(right.value));
}

function ownershipEntries(value, label) {
	if (!Array.isArray(value)) throw new Error(`${label} 接管清单损坏`);
	const paths = new Set();
	for (const entry of value) {
		const path = JSON.stringify(entry?.path);
		if (!entry || !Array.isArray(entry.path) || !entry.path.length || entry.path.some((key) => typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)) ||
			typeof entry.baseline?.exists !== "boolean" || typeof entry.applied?.exists !== "boolean" ||
			(entry.baseline.exists && !Object.hasOwn(entry.baseline, "value")) || (entry.applied.exists && !Object.hasOwn(entry.applied, "value")) ||
			(entry.relinquished !== undefined && typeof entry.relinquished !== "boolean") || paths.has(path)) throw new Error(`${label} 接管清单损坏`);
		paths.add(path);
	}
	return value;
}

async function readOwnership(path, required = false) {
	if (!existsSync(path)) {
		if (required) throw new Error("Pi/FireCode 配置接管清单缺失；已保留 backups");
		return { version: 1, settings: [], keybindings: [], firecode: [] };
	}
	const ownership = await readObject(path);
	if (ownership.version !== 1) throw new Error("Pi/FireCode 配置接管清单版本损坏；已保留 backups");
	ownership.settings = ownershipEntries(ownership.settings, "Pi settings");
	ownership.keybindings = ownershipEntries(ownership.keybindings, "Pi keybindings");
	ownership.firecode = ownershipEntries(ownership.firecode, "FireCode");
	if (typeof ownership.firecodeAbsent !== "boolean") throw new Error("FireCode 配置接管清单损坏");
	return ownership;
}

function setAt(object, path, state) {
	let target = object;
	for (const key of path.slice(0, -1)) target = target[key] ??= {};
	const key = path.at(-1);
	if (state.exists) target[key] = state.value;
	else delete target[key];
}

function reconcileManaged(current, rendered, paths, previousEntries) {
	const previous = new Map(previousEntries.map((entry) => [JSON.stringify(entry.path), entry]));
	const all = new Map([...paths, ...previousEntries.map((entry) => entry.path)].map((path) => [JSON.stringify(path), path]));
	const entries = [];
	for (const [key, path] of all) {
		const prior = previous.get(key);
		const currentValue = valueAt(current, path);
		if (prior?.relinquished || (prior && !same(currentValue, prior.applied))) {
			setAt(rendered, path, currentValue);
			entries.push({ ...(prior ?? {}), path, baseline: prior?.baseline ?? currentValue, applied: prior?.applied ?? valueAt(rendered, path), relinquished: true });
			continue;
		}
		entries.push({ path, baseline: prior?.baseline ?? currentValue, applied: valueAt(rendered, path), relinquished: false });
	}
	return entries;
}

function restoreManaged(current, entries) {
	for (const entry of entries) {
		if (!entry.relinquished && same(valueAt(current, entry.path), entry.applied)) setAt(current, entry.path, entry.baseline);
	}
}

function prune(object) {
	for (const [key, value] of Object.entries(object)) {
		if (value && typeof value === "object" && !Array.isArray(value)) {
			prune(value);
			if (!Object.keys(value).length) delete object[key];
		}
	}
	return object;
}

export async function restore(options) {
	const ownershipPath = resolve(options.ownership);
	const settingsPath = resolve(options["pi-settings"]);
	const keybindingsPath = resolve(options["pi-keybindings"]);
	const settingsBackup = resolve(options["pi-settings-backup"]);
	const keybindingsBackup = resolve(options["pi-keybindings-backup"]);
	const firecodePath = resolve(options.firecode);
	const [settings, keybindings, firecode, ownership] = await Promise.all([
		readObject(settingsPath),
		readObject(keybindingsPath),
		readObject(firecodePath, true),
		readOwnership(ownershipPath, true),
	]);
	restoreManaged(settings, ownership.settings);
	restoreManaged(keybindings, ownership.keybindings);
	restoreManaged(firecode, ownership.firecode);
	prune(settings); prune(keybindings); prune(firecode);
	await Promise.all([
		writeRestored(settingsPath, settings, existsSync(`${settingsBackup}.absent`)),
		writeRestored(keybindingsPath, keybindings, existsSync(`${keybindingsBackup}.absent`)),
		writeRestored(firecodePath, firecode, ownership.firecodeAbsent === true),
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
				watcher: false,
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
	const previousOwnership = await readOwnership(ownershipPath);
	const settingsPaths = [["warnings", "anthropicExtraUsage"]];
	if (managesModels) {
		for (const key of ["defaultProvider", "defaultModel", "defaultThinkingLevel", "enabledModels"]) settingsPaths.push([key]);
	}
	const keybindingPaths = Object.keys(profile.keybindings).map((key) => [key]);
	const firecodePaths = [...FIRECODE_PATHS, ...Object.keys(profile.presets).map((name) => ["presets", name])];
	const managedSettings = reconcileManaged(settings, rendered.piSettings, settingsPaths, previousOwnership.settings);
	const managedKeybindings = reconcileManaged(keybindings, rendered.piKeybindings, keybindingPaths, previousOwnership.keybindings);
	const managedFirecode = reconcileManaged(firecode, rendered.firecode, firecodePaths, previousOwnership.firecode);
	prune(rendered.piSettings); prune(rendered.piKeybindings); prune(rendered.firecode);
	const firecodeAbsent = previousOwnership.firecodeAbsent ?? !existsSync(firecodePath);
	await Promise.all([
		atomicJson(settingsPath, rendered.piSettings),
		atomicJson(keybindingsPath, rendered.piKeybindings),
		atomicJson(firecodePath, rendered.firecode),
	]);
	await atomicJson(ownershipPath, {
		version: 1,
		settings: managedSettings,
		keybindings: managedKeybindings,
		firecodeAbsent,
		firecode: managedFirecode,
	});
	return { configuredModels: rendered.piSettings.enabledModels?.length ?? 0, providers };
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
	const options = args(process.argv.slice(2));
	const operation = options.mode === "restore"
		? restore(options)
		: options.mode === "validate"
			? readOwnership(resolve(options.ownership), true)
			: configure(options);
	operation
		.then((result) => process.stdout.write(`${JSON.stringify(result ?? { restored: true })}\n`))
		.catch((error) => {
			process.stderr.write(`${error.message}\n`);
			process.exitCode = 1;
		});
}
