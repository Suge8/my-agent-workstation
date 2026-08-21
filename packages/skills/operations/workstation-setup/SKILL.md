---
name: workstation-setup
description: 配置或维护 My Agent Workstation；用户说“继续配置工作站”，或要求检查、验证、更新、修复、卸载工作站时使用。Pi 尚未安装时引导运行公开安装命令。
---

# 工作站控制面

`setup` 是唯一控制面；本 Skill 只调用它，不手工复制安装逻辑。

## 1. 定位

```bash
if test -n "${MYAW_SETUP:-}"; then
  setup=$MYAW_SETUP
else
  state=${MYAW_HOME:-${XDG_DATA_HOME:-"$HOME/.local/share"}/my-agent-workstation}/state.json
  root=$(STATE_FILE="$state" node -e 'const fs=require("node:fs");const s=JSON.parse(fs.readFileSync(process.env.STATE_FILE,"utf8"));process.stdout.write(s.installation_root||"")') || root=
  test -n "$root" || exit 1
  setup=$root/setup
fi
test -x "$setup"
```

定位失败时，让用户运行 README 的公开安装命令；该命令会先装好 Pi、Herdr 和本 Skill。不要在 Agent 中重建安装步骤。

**完成：** `setup` 来自 `MYAW_SETUP` 或安装状态中的 `installation_root`。

## 2. 诊断

运行 `"$setup" doctor --json`，按退出码和结构化状态解释当前环境。诊断失败或输出无效时原样报告并停止。

用户要继续首次配置且 `model_auth` 不是 `normal` 时，说明模型能力尚未启用，让用户在 Pi 中运行 `/login`；用户完成后重新诊断。OAuth 规则见 [CONFIRMATIONS.md](CONFIRMATIONS.md)。

**完成：** 当前状态和唯一下一步已经明确；变更尚未开始。

## 3. 收敛

以 `"$setup" --help` 为参数事实源：

- “继续配置工作站”默认收敛到 `apply --mode full`。
- 只检查或解释时停在诊断；预览时只运行 `plan`。
- 更新、修复、验收、卸载分别使用 `update`、`repair`、`verify`、`uninstall`。

变更前读取 [CONFIRMATIONS.md](CONFIRMATIONS.md)，取得当前计划需要的选择，再运行带相同参数的 `plan`。向用户展示动作和保留项，明确确认后才执行；按对话语言传 `--architecture-language zh|en`。用户改了选择就重新生成计划。

**完成：** 执行内容与用户确认的计划完全一致，或安全停在待确认状态。

## 4. 验收

执行 `apply` 后先判断退出码，再读取 JSON 的 `valid`：

- 退出码非零：核心安装失败，报告失败动作并停止。
- 退出码为零且 `valid` 为 `false`：安装已落盘，按返回状态引导用户完成认证、权限或密钥。
- 退出码为零且 `valid` 为 `true`：进入最终验收。

随后运行 `verify` 和 `doctor --json`；不绕过控制面手改文件。配置或更新 Pi Package 后，让用户重启 Pi 一次，使快捷键和启动期配置生效。

**完成：** `verify` 通过；若存在必须由人完成的操作，状态已保存且用户拿到唯一续跑步骤。
