# 模型选择

`recommended.json` 是推荐角色和快捷键的单一事实源。安装器只启用已认证且存在于当前 Pi 模型目录中的条目。

自定义时创建一个 JSON 文件并传给 `setup --selections <path>`：

```json
{
  "models": {
    "sol": "openai-codex/gpt-5.6-sol",
    "gemini": null
  },
  "default": "openai-codex/gpt-5.6-sol",
  "disabled": ["review", "watcher"]
}
```

`models` 的键必须来自推荐档；值是 `provider/model`，`null` 表示禁用该别名。`disabled` 只接受 `presets`、`master`、`review`、`watcher`。Watcher 默认在每个主会话回合后调用推荐模型；不接受额外调用时应显式禁用。安装器会保存这份不含凭据的选择并在更新时复用；模型不可用或供应商未认证时拒绝写入。
