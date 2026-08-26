import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { RECOMMENDED_PROFILE, renderModelProfile } from "../scripts/render-model-profile.mjs";

const profile = JSON.parse(await readFile(RECOMMENDED_PROFILE, "utf8"));
const allProviders = [...new Set(Object.values(profile.models).map(({ provider }) => provider))];
const availableModels = Object.values(profile.models).map(({ provider, model }) => `${provider}/${model}`);
const cycle = [
  "openai-codex/gpt-5.6-sol",
  "openai-codex/gpt-5.6-terra",
  "openai-codex/gpt-5.6-luna",
  "openai-codex/gpt-5.4-mini",
  "openai-codex/gpt-5.3-codex-spark",
  "anthropic/claude-fable-5",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-opus-5",
  "anthropic/claude-opus-4-6",
  "xai/grok-4.6",
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro",
  "kimi-coding/k3",
  "kimi-coding/k3-256k",
  "antigravity/gemini-3.7-flash",
];

function render(overrides = {}) {
  return renderModelProfile({ profile, authenticatedProviders: allProviders, availableModels, ...overrides });
}

test("推荐档只声明公开 provider/model id 且 Pi 循环为维护者当前 15 项", () => {
  assert.equal(profile.cycle.length, 15);
  assert.deepEqual(
    profile.cycle.map((alias) => `${profile.models[alias].provider}/${profile.models[alias].model}`),
    cycle,
  );
  for (const model of Object.values(profile.models)) {
    assert.match(model.provider, /^(antigravity|anthropic|deepseek|kimi-coding|openai|openai-codex|xai)$/);
    assert.match(model.model, /^[a-z0-9][a-z0-9.-]*$/);
  }
  assert.doesNotMatch(JSON.stringify(profile), /(api[_-]?key|credential|proxy|baseUrl|right codes)/i);
});

test("生成完整 Pi、预设及当前公开 FireCode roster", () => {
  const result = render();
  assert.equal(result.piSettings.defaultProvider, "openai-codex");
  assert.equal(result.piSettings.defaultModel, "gpt-5.6-sol");
  assert.equal(result.piSettings.defaultThinkingLevel, "medium");
  assert.deepEqual(result.piSettings.enabledModels, cycle);
  assert.equal(result.piSettings.warnings.anthropicExtraUsage, false);
  assert.deepEqual(
    Object.entries(result.firecode.presets).map(([name, value]) => [name, value.key, `${value.provider}/${value.model}`]),
    [
      ["fable", "alt+1", "anthropic/claude-fable-5"],
      ["opus5", "alt+2", "anthropic/claude-opus-5"],
      ["sol", "alt+3", "openai-codex/gpt-5.6-sol"],
      ["gemini", "alt+4", "antigravity/gemini-3.7-flash"],
      ["ds", "alt+5", "deepseek/deepseek-v4-flash"],
      ["k3-256", "alt+6", "kimi-coding/k3-256k"],
      ["xai", "alt+7", "xai/grok-4.6"],
    ],
  );
  assert.deepEqual(result.firecode.master.models, [
    { model: "openai-codex/gpt-5.6-sol", thinking: "medium", use: "常规调研与实现、调试" },
    { model: "antigravity/gemini-3.7-flash", thinking: "high", use: "快速轻量调研" },
    { model: "openai-codex/gpt-5.6-luna", thinking: "xhigh", use: "大规模并行快任务" },
    { model: "anthropic/claude-opus-5", thinking: "medium", use: "前端与综合架构" },
    { model: "anthropic/claude-fable-5", thinking: "high", use: "高级架构顾问" },
    { model: "kimi-coding/k3-256k", thinking: "high", use: "视觉设计" },
  ]);
  assert.deepEqual(result.firecode.review.advisor, { model: "anthropic/claude-fable-5", thinking: "high" });
  assert.deepEqual(result.firecode.review.reviewers, [
    { model: "anthropic/claude-sonnet-5", thinking: "medium" },
    { model: "anthropic/claude-opus-5", thinking: "medium" },
    { model: "openai-codex/gpt-5.6-sol", thinking: "medium" },
  ]);
  assert.deepEqual(result.firecode.watcher, {
    enabled: true,
    model: "openai-codex/gpt-5.6-sol",
    thinking: "low",
    context: "minimal",
  });
  assert.equal(result.firecode.features.watcher, true);
});

test("watcher 可显式禁用且不会保留模型", () => {
  const result = render({ selections: { disabled: ["watcher"] } });
  assert.equal(result.firecode.features.watcher, false);
  assert.equal(result.firecode.watcher.model, undefined);
});

test("provider 缺失时必须显式替换或设 null", () => {
  assert.throws(
    () => renderModelProfile({ profile, authenticatedProviders: ["openai-codex"], availableModels }),
    /provider anthropic 未认证/,
  );
  const unavailable = Object.fromEntries(
    Object.entries(profile.models)
      .filter(([, model]) => model.provider !== "openai-codex")
      .map(([alias]) => [alias, null]),
  );
  const result = renderModelProfile({
    profile,
    authenticatedProviders: ["openai-codex"],
    availableModels,
    selections: { models: unavailable, disabled: ["master", "review"] },
  });
  assert.deepEqual(result.piSettings.enabledModels, cycle.slice(0, 5));
  assert.equal(result.firecode.features.master, false);
  assert.equal(result.firecode.features.review, false);
  assert.doesNotMatch(JSON.stringify(result), /anthropic\/|antigravity\/|deepseek\/|kimi-coding\/|xai\//);
});

test("拒绝最终引用但不在当前 Pi 目录中的模型", () => {
  assert.throws(
    () => render({ selections: { models: { opus5: "openai-codex/definitely-not-a-real-model" } } }),
    /不在当前 Pi 可用模型目录中/,
  );
  assert.throws(
    () => render({ availableModels: availableModels.filter((model) => model !== "anthropic/claude-fable-5") }),
    /anthropic\/claude-fable-5 不在当前 Pi 可用模型目录中/,
  );
  assert.throws(
    () => render({ firecode: { presets: { custom: { provider: "openai-codex", model: "missing" } } } }),
    /openai-codex\/missing 不在当前 Pi 可用模型目录中/,
  );
});

test("模块可在没有脚本入口参数的 ESM 宿主中导入", () => {
  const result = spawnSync(process.execPath, ["-e", "import('./scripts/render-model-profile.mjs')"], {
    cwd: new URL("..", import.meta.url),
  });
  assert.equal(result.status, 0, result.stderr.toString());
});

test("保留无关配置并应用当前快捷键基线", () => {
  const result = render({
    piSettings: {
      theme: "light",
      warnings: { terminal: false, anthropicExtraUsage: true },
      compaction: { reserveTokens: 1234 },
    },
    piKeybindings: {
      "tui.editor.cursorUp": "alt+k",
      "app.session.rename": ["ctrl+r", "alt+r"],
      "tui.input.tab": "tab",
    },
    firecode: {
      features: { header: false },
      openai: { nativeCompaction: true },
      keys: { rename: "alt+x" },
      presets: {
        custom: { provider: "openai-codex", model: "gpt-5.6-sol", thinkingLevel: "high", key: "alt+9" },
      },
      review: { language: "en", maxRounds: 2 },
    },
  });
  assert.equal(result.piSettings.theme, "light");
  assert.equal(result.piSettings.warnings.terminal, false);
  assert.deepEqual(result.piSettings.compaction, { reserveTokens: 1234 });
  assert.equal(result.piKeybindings["tui.editor.cursorUp"], "alt+k");
  assert.deepEqual(result.piKeybindings["app.model.cycleForward"], ["shift+tab"]);
  assert.deepEqual(result.piKeybindings["app.thinking.cycle"], ["tab"]);
  assert.deepEqual(result.piKeybindings["tui.input.tab"], []);
  assert.deepEqual(result.piKeybindings["tui.editor.cursorWordRight"], ["alt+right", "ctrl+right"]);
  assert.deepEqual(result.piKeybindings["tui.editor.cursorRight"], ["right"]);
  assert.deepEqual(result.piKeybindings["app.session.rename"], ["alt+r"]);
  assert.equal(result.firecode.features.header, false);
  assert.deepEqual(result.firecode.openai, { nativeCompaction: true });
  assert.deepEqual(Object.keys(result.firecode.presets), [
    "fable",
    "opus5",
    "sol",
    "gemini",
    "ds",
    "k3-256",
    "xai",
    "custom",
  ]);
  assert.deepEqual(result.firecode.presets.custom, {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    thinkingLevel: "high",
    key: "alt+9",
  });
  assert.equal(result.firecode.review.language, "en");
  assert.equal(result.firecode.review.maxRounds, 2);
  assert.deepEqual(result.firecode.keys, {
    rename: "ctrl+r",
    cyclePreset: "ctrl+shift+u",
    fast: "ctrl+f",
  });
});
