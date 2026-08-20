import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { RECOMMENDED_PROFILE, renderModelProfile } from "../scripts/render-model-profile.mjs";

const profile = JSON.parse(await readFile(RECOMMENDED_PROFILE, "utf8"));
const models = Object.values(profile.models);

test("停用的发行示例预设不会阻塞或污染推荐预设", () => {
  const result = renderModelProfile({
    profile,
    authenticatedProviders: [...new Set(models.map(({ provider }) => provider))].filter(
      (provider) => provider !== "openai",
    ),
    availableModels: models
      .map(({ provider, model }) => `${provider}/${model}`)
      .filter((model) => model !== "openai/gpt-4.1"),
    selections: { disabled: ["master", "review"] },
    firecode: {
      features: { presets: false },
      presets: {
        default: {
          provider: "openai",
          model: "gpt-4.1",
          thinkingLevel: "medium",
          key: "alt+1",
        },
        personal: {
          provider: "openai-codex",
          model: "gpt-5.6-sol",
          thinkingLevel: "high",
          key: "alt+9",
        },
      },
    },
  });

  assert.equal(result.firecode.features.presets, true);
  assert.equal(result.firecode.presets.default, undefined);
  assert.deepEqual(result.firecode.presets.personal, {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    thinkingLevel: "high",
    key: "alt+9",
  });
  assert.deepEqual(
    Object.values(result.firecode.presets).map(({ key }) => key),
    ["alt+1", "alt+2", "alt+3", "alt+4", "alt+5", "alt+6", "alt+7", "alt+9"],
  );
});

test("显式禁用 presets 时保留自定义定义但不校验模型", () => {
  const result = renderModelProfile({
    profile,
    authenticatedProviders: [...new Set(models.map(({ provider }) => provider))],
    availableModels: models.map(({ provider, model }) => `${provider}/${model}`),
    selections: { disabled: ["presets", "master", "review"] },
    firecode: {
      features: { presets: false },
      presets: {
        personal: { provider: "missing", model: "not-real", key: "alt+9" },
      },
    },
  });

  assert.equal(result.firecode.features.presets, false);
  assert.deepEqual(result.firecode.presets.personal, {
    provider: "missing",
    model: "not-real",
    key: "alt+9",
  });
});
