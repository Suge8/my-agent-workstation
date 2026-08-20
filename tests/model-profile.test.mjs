import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { RECOMMENDED_PROFILE, renderModelProfile } from "../scripts/render-model-profile.mjs";

const profile = JSON.parse(await readFile(RECOMMENDED_PROFILE, "utf8"));
const allProviders = ["openai-codex", "anthropic", "kimi-coding"];
const availableModels = Object.values(profile.models).map(({ provider, model }) => `${provider}/${model}`);

function render(overrides = {}) {
  return renderModelProfile({ profile, authenticatedProviders: allProviders, availableModels, ...overrides });
}

test("推荐档只声明公开 provider/model id", () => {
  assert.deepEqual(Object.keys(profile.models).sort(), ["kimi", "luna", "opus", "sol", "sonnet"]);
  for (const model of Object.values(profile.models)) {
    assert.match(model.provider, /^(anthropic|kimi-coding|openai-codex)$/);
    assert.match(model.model, /^[a-z0-9][a-z0-9.-]*$/);
  }
  assert.doesNotMatch(JSON.stringify(profile), /(api[_-]?key|credential|proxy|baseUrl|right codes)/i);
});

test("推荐档生成 Pi、快捷键、预设、Master 和 Review", () => {
  const result = render();
  assert.equal(result.piSettings.defaultProvider, "openai-codex");
  assert.equal(result.piSettings.defaultModel, "gpt-5.6-sol");
  assert.deepEqual(result.piSettings.enabledModels, [
    "openai-codex/gpt-5.6-sol",
    "openai-codex/gpt-5.6-luna",
    "anthropic/claude-sonnet-5",
    "anthropic/claude-opus-5",
    "kimi-coding/k3-256k",
  ]);
  assert.equal(result.piSettings.warnings.anthropicExtraUsage, false);
  assert.equal(result.firecode.master.models.length, 4);
  assert.equal(result.firecode.review.reviewers.length, 3);
  assert.equal(result.firecode.presets.sol.key, "alt+1");
});

test("provider 缺失时必须显式替换或禁用且不留下失效模型", () => {
  assert.throws(
    () => renderModelProfile({ profile, authenticatedProviders: ["openai-codex"], availableModels }),
    /provider anthropic 未认证/,
  );
  const result = renderModelProfile({
    profile,
    authenticatedProviders: ["openai-codex"],
    availableModels,
    selections: {
      models: {
        opus: "openai-codex/gpt-5.6-sol",
        sonnet: null,
        kimi: null,
      },
      disabled: ["review"],
    },
  });
  assert.equal(result.firecode.features.review, false);
  assert.equal(result.firecode.review.advisor, undefined);
  assert.equal(result.firecode.review.reviewers, undefined);
  assert.equal(result.firecode.presets.opus.provider, "openai-codex");
  assert.doesNotMatch(JSON.stringify(result), /anthropic\/|kimi-coding\//);
});

test("拒绝不在当前 Pi 模型目录中的推荐或替代模型", () => {
  assert.throws(
    () => render({ selections: { models: { opus: "openai-codex/definitely-not-a-real-model" } } }),
    /不在当前 Pi 可用模型目录中/,
  );
  assert.throws(
    () => render({ availableModels: availableModels.filter((model) => model !== "anthropic/claude-opus-5") }),
    /anthropic\/claude-opus-5 不在当前 Pi 可用模型目录中/,
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

test("保留无关配置并应用完整快捷键基线", () => {
  const result = render({
    piSettings: {
      theme: "light",
      warnings: { terminal: false, anthropicExtraUsage: true },
      compaction: { reserveTokens: 1234 },
    },
    piKeybindings: { "tui.editor.cursorUp": "alt+k", "app.thinking.cycle": "shift+tab" },
    firecode: {
      features: { header: false },
      openai: { nativeCompaction: true },
      keys: { rename: "alt+x" },
      presets: {
        custom: {
          provider: "openai-codex",
          model: "gpt-5.6-sol",
          thinkingLevel: "high",
          key: "alt+9",
        },
      },
      review: { language: "en", maxRounds: 2 },
    },
  });
  assert.equal(result.piSettings.theme, "light");
  assert.equal(result.piSettings.warnings.terminal, false);
  assert.deepEqual(result.piSettings.compaction, { reserveTokens: 1234 });
  assert.equal(result.piKeybindings["tui.editor.cursorUp"], "alt+k");
  assert.equal(result.piKeybindings["app.thinking.cycle"], "tab");
  assert.equal(result.piKeybindings["app.model.cycleForward"], "shift+tab");
  assert.deepEqual(result.piKeybindings["app.session.rename"], ["ctrl+r", "alt+r"]);
  assert.equal(result.firecode.features.header, false);
  assert.deepEqual(result.firecode.openai, { nativeCompaction: true });
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
