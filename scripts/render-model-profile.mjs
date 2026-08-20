#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const RECOMMENDED_PROFILE = resolve(ROOT, "resources/models/recommended.json");
const CAPABILITIES = new Set(["presets", "master", "review"]);

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value;
}

function modelRef(value, label) {
  if (typeof value !== "string" || !value.includes("/")) throw new Error(`${label} 必须是 provider/model`);
  const slash = value.indexOf("/");
  const provider = value.slice(0, slash);
  const model = value.slice(slash + 1);
  if (!provider || !model) throw new Error(`${label} 必须是 provider/model`);
  return { provider, model, ref: value };
}

function unique(items, key = (item) => item) {
  const seen = new Set();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function withoutModelFields(section, fields) {
  const result = { ...object(section ?? {}, "FireCode 配置节") };
  for (const field of fields) delete result[field];
  return result;
}

export function renderModelProfile({
  profile,
  authenticatedProviders,
  availableModels,
  selections = {},
  piSettings = {},
  piKeybindings = {},
  firecode = {},
}) {
  object(profile, "模型档案");
  object(profile.models, "模型档案 models");
  object(selections, "用户选择");
  object(selections.models ?? {}, "用户选择 models");
  const authenticated = new Set(authenticatedProviders ?? []);
  if (!Array.isArray(availableModels)) throw new Error("availableModels 必须是当前 Pi 可用模型数组");
  const available = new Set(availableModels.map((value) => modelRef(value, "可用模型").ref));
  const acceptModel = (model) => {
    if (!authenticated.has(model.provider)) throw new Error(`provider ${model.provider} 未认证，拒绝使用 ${model.ref}`);
    if (!available.has(model.ref)) throw new Error(`模型 ${model.ref} 不在当前 Pi 可用模型目录中`);
    return model;
  };
  const disabled = new Set(selections.disabled ?? []);
  for (const capability of disabled) {
    if (!CAPABILITIES.has(capability)) throw new Error(`未知能力：${capability}`);
  }
  for (const alias of Object.keys(selections.models ?? {})) {
    if (!profile.models[alias]) throw new Error(`未知模型别名：${alias}`);
  }

  const resolved = new Map();
  for (const [alias, source] of Object.entries(profile.models)) {
    const chosen = Object.hasOwn(selections.models ?? {}, alias)
      ? selections.models[alias]
      : `${source.provider}/${source.model}`;
    if (chosen === null) {
      resolved.set(alias, null);
      continue;
    }
    resolved.set(alias, acceptModel(modelRef(chosen, `模型选择 ${alias}`)));
  }

  const resolveAlias = (alias) => {
    if (!resolved.has(alias)) throw new Error(`模型档案引用未知别名：${alias}`);
    return resolved.get(alias);
  };
  const selectedDefault = selections.default
    ? modelRef(selections.default, "默认模型")
    : resolveAlias(profile.default);
  if (!selectedDefault) throw new Error(`默认模型 ${profile.default} 已禁用，请显式选择替代模型`);
  acceptModel(selectedDefault);

  const cycle = unique([selectedDefault, ...profile.cycle.map(resolveAlias).filter(Boolean)], (item) => item.ref);
  const settings = {
    ...object(piSettings, "Pi settings"),
    defaultProvider: selectedDefault.provider,
    defaultModel: selectedDefault.model,
    enabledModels: cycle.map((item) => item.ref),
    warnings: {
      ...object(piSettings.warnings ?? {}, "Pi settings warnings"),
      anthropicExtraUsage: false,
    },
  };
  const keybindings = {
    ...object(piKeybindings, "Pi keybindings"),
    ...profile.keybindings,
  };

  const currentFirecode = object(firecode, "FireCode config");
  const features = { ...object(currentFirecode.features ?? {}, "FireCode features") };
  const currentPresets = object(currentFirecode.presets ?? {}, "FireCode presets");
  const managedPresets = new Set(Object.keys(profile.presets));
  const presets = {};
  for (const [name, preset] of Object.entries(currentPresets)) {
    if (managedPresets.has(name)) continue;
    const custom = object(preset, `FireCode preset ${name}`);
    if (typeof custom.provider === "string" && typeof custom.model === "string") {
      acceptModel(modelRef(`${custom.provider}/${custom.model}`, `FireCode preset ${name}`));
    }
    presets[name] = custom;
  }
  if (!disabled.has("presets")) {
    for (const [name, preset] of Object.entries(profile.presets)) {
      const model = resolveAlias(preset.model);
      if (model) presets[name] = { ...preset, provider: model.provider, model: model.model };
    }
  }
  features.presets = !disabled.has("presets") && Object.keys(presets).length > 0;

  const masterModels = disabled.has("master")
    ? []
    : unique(
        profile.master.flatMap((entry) => {
          const model = resolveAlias(entry.model);
          return model ? [{ ...entry, model: model.ref }] : [];
        }),
        (entry) => entry.model,
      );
  features.master = masterModels.length > 0;

  const advisor = disabled.has("review") ? null : resolveAlias(profile.review.advisor.model);
  const reviewers = disabled.has("review")
    ? []
    : unique(
        profile.review.reviewers.flatMap((entry) => {
          const model = resolveAlias(entry.model);
          return model ? [{ ...entry, model: model.ref }] : [];
        }),
        (entry) => entry.model,
      );
  features.review = Boolean(advisor && reviewers.length);

  const nextFirecode = {
    ...currentFirecode,
    features,
    keys: { ...object(currentFirecode.keys ?? {}, "FireCode keys"), ...profile.firecodeKeys },
    presets,
    master: features.master
      ? { ...object(currentFirecode.master ?? {}, "FireCode master"), models: masterModels }
      : withoutModelFields(currentFirecode.master, ["models"]),
    review: features.review
      ? {
          ...object(currentFirecode.review ?? {}, "FireCode review"),
          advisor: { ...profile.review.advisor, model: advisor.ref },
          reviewers,
        }
      : withoutModelFields(currentFirecode.review, ["advisor", "reviewers"]),
  };
  return { piSettings: settings, piKeybindings: keybindings, firecode: nextFirecode };
}

export function parseJsonc(text) {
  let output = "";
  let string = false;
  let escape = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (string) {
      output += char;
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') string = false;
    } else if (char === '"') {
      string = true;
      output += char;
    } else if (char === "/" && text[index + 1] === "/") {
      while (index + 1 < text.length && text[index + 1] !== "\n") index += 1;
    } else if (char === "/" && text[index + 1] === "*") {
      index += 2;
      while (index < text.length && !(text[index - 1] === "*" && text[index] === "/")) index += 1;
    } else output += char;
  }
  return JSON.parse(output);
}

async function readConfig(path, jsonc = false) {
  if (!path) return {};
  try {
    const text = await readFile(path, "utf8");
    return object(jsonc ? parseJsonc(text) : JSON.parse(text), path);
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--providers", "--available-models", "--selections", "--profile", "--pi-settings", "--pi-keybindings", "--firecode"].includes(flag)) {
      throw new Error(`未知参数：${flag}`);
    }
    const value = argv[++index];
    if (!value) throw new Error(`${flag} 缺少值`);
    options[flag.slice(2)] = value;
  }
  if (!options.providers) throw new Error("必须提供 --providers provider,...");
  if (!options["available-models"]) throw new Error("必须提供 --available-models provider/model,...");
  return options;
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const profilePath = resolve(options.profile ?? RECOMMENDED_PROFILE);
  const paths = {
    piSettings: options["pi-settings"] && resolve(options["pi-settings"]),
    piKeybindings: options["pi-keybindings"] && resolve(options["pi-keybindings"]),
    firecode: options.firecode && resolve(options.firecode),
  };
  const [profile, selections, piSettings, piKeybindings, firecode] = await Promise.all([
    readConfig(profilePath),
    readConfig(options.selections && resolve(options.selections)),
    readConfig(paths.piSettings),
    readConfig(paths.piKeybindings),
    readConfig(paths.firecode, true),
  ]);
  const rendered = renderModelProfile({
    profile,
    authenticatedProviders: options.providers.split(",").filter(Boolean),
    availableModels: options["available-models"].split(",").filter(Boolean),
    selections,
    piSettings,
    piKeybindings,
    firecode,
  });
  await Promise.all([
    paths.piSettings && writeJson(paths.piSettings, rendered.piSettings),
    paths.piKeybindings && writeJson(paths.piKeybindings, rendered.piKeybindings),
    paths.firecode && writeJson(paths.firecode, rendered.firecode),
  ]);
  process.stdout.write(`${JSON.stringify(rendered, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
