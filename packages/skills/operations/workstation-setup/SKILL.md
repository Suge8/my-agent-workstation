---
name: workstation-setup
description: 维护 My Agent Workstation：检查、解释、配置、验证、更新、修复或卸载已安装环境。首次安装且 Pi 不可用时改走 Shell 向导。
---

# 工作站维护

`setup` 是唯一控制面；本 Skill 只定位并调用它，不实现安装动作。

## 1. 定位控制面

运行时按固定优先级解析路径：

```bash
if test -n "${MYAW_SETUP:-}"; then
  setup=$MYAW_SETUP
else
  state=${MYAW_HOME:-${XDG_DATA_HOME:-"$HOME/.local/share"}/my-agent-workstation}/state.json
  root=$(STATE_FILE="$state" node -e 'const fs=require("node:fs");const s=JSON.parse(fs.readFileSync(process.env.STATE_FILE,"utf8"));process.stdout.write(s.installation_root||"")') || root=
  test -n "$root" || exit 1
  setup=$root/setup
fi
test -n "$setup" && test -x "$setup"
```

只接受这两个来源。定位失败时停止；若是首次安装或没有 Pi，让用户在自己的仓库 checkout 中运行 `./setup`，由中文 Shell 向导完成，不在 Agent 中重建流程。

**完成：** `setup` 指向可执行文件，且路径来自 `MYAW_SETUP` 或状态记录的 `installation_root`。

## 2. 先诊断并解释

始终先运行：

```bash
"$setup" doctor --json
```

按原始退出码判断命令是否成功，以结构化字段判断环境是否健康。用中文说明系统是否受支持、每个组件的状态、阻塞项，以及哪些问题需要用户操作；不得展示凭据。诊断失败或输出无效时原样说明错误并停止变更。

**完成：** 用户已经看到当前状态、问题和下一步；尚未执行变更。

## 3. 按明确意图行动

以 `"$setup" --help` 为当前命令与参数的事实源，并只执行与用户明确意图对应的能力：

- 只检查或询问原因：停在 `doctor --json` 的解释。
- 预览变更：调用 `plan`，解释动作、影响和保留项。
- 安装、补装或配置：先 `plan`，确认后调用 `apply`。按当前对话语言传 `--architecture-language zh` 或 `en`；判断不了时询问一次。
- 验收环境：调用 `verify`。
- 更新、修复或卸载：分别调用 `update`、`repair` 或 `uninstall`；先展示该命令给出的计划。

计划涉及覆盖、卸载、SYSTEM、独立 FireCode 迁移、权限、OAuth 或密钥时，先读取并执行 [CONFIRMATIONS.md](CONFIRMATIONS.md)。用户未明确选择时停在计划；不把自然语言猜测当授权。所有实际读写仍由 `setup` 完成。

**完成：** 只调用了所请求的生命周期能力；每个敏感关口已有明确选择，或流程安全停住。

## 4. 收尾

变更命令成功后调用 `verify`，再调用 `doctor --json` 解释最终状态。命令失败时报告退出码、失败动作和控制面给出的恢复建议，不以其他命令或手工改文件绕过。

**完成：** `verify` 通过且最终诊断无待处理问题；若仍依赖用户授权或认证，则明确列出唯一下一步并标记未完成。
