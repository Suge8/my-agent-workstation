#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
	for (const required of ["profile", "pi-settings", "pi-keybindings", "firecode"]) {
		if (!options[required]) throw new Error(`缺少 --${required}`);
	}
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

function modelRef(model) {
	return `${model.provider}/${model.model}`;
}

function baseConfiguration(profile, providers, settings, keybindings, firecode) {
	const providerSet = new Set(providers);
	return {
		piSettings: {
			...settings,
			warnings: { ...(settings.warnings ?? {}), anthropicExtraUsage: false },
		},
		piKeybindings: { ...keybindings, ...profile.keybindings },
		firecode: {
			...firecode,
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
	if (providers.length && available.length) {
		const selections = automaticSelections(profile, providers, available, supplied);
		const defaultDisabled = selections.models?.[profile.default] === null && !selections.default;
		if (!defaultDisabled) {
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
	await Promise.all([
		atomicJson(settingsPath, rendered.piSettings),
		atomicJson(keybindingsPath, rendered.piKeybindings),
		atomicJson(firecodePath, rendered.firecode),
	]);
	return { configuredModels: rendered.piSettings.enabledModels?.length ?? 0, providers };
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
	configure(args(process.argv.slice(2)))
		.then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
		.catch((error) => {
			process.stderr.write(`${error.message}\n`);
			process.exitCode = 1;
		});
}
