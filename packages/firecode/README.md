# FireCode

FireCode 是一个模块化 Pi Package，提供终端状态与工具渲染、会话预设、`/fire-review` 对抗审查和按需 `/fire-master` 子代理委派。各模块由功能开关独立注册；关闭任一模块不会改变其余模块。

## 安装

```bash
pi install git:github.com/Suge8/firecode@v0.1.0
```

也可在本地仓库中直接试用：

```bash
pi -e .
```

Pi Package 拥有与 Pi 相同的本机权限；安装前应审阅源码。

## 配置

运行配置不随包分发。将公开模板复制到 Pi Agent 目录后按需启用功能，再重启 Pi：

```bash
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$agent_dir/extensions/firecode"
curl -fsSL https://raw.githubusercontent.com/Suge8/firecode/v0.1.0/config.example.jsonc \
  -o "$agent_dir/extensions/firecode/config.jsonc"
```

模板默认只启用本地界面与会话功能。Provider、Bark 通知、审查和子代理委派涉及外部服务或本机工具，配置完成后再开启。缺少运行配置时，FireCode 会关闭可选功能并在会话启动时警告；模板本身不会被运行时读取。

## 开发

需要 [Bun](https://bun.sh/) 和一个 pi-mono checkout。开发版 `pi` 在 `PATH` 中时，测试会自动定位它；否则设置 `PI_PACKAGES_DIR` 为 pi-mono 的 `packages/` 目录。

```bash
bun test
```

模块边界、状态机约束和领域术语见 `AGENTS.md`、各模块的 `AGENTS.md` 与 `CONTEXT.md`。
