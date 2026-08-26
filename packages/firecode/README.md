# FireCode

FireCode 是一个模块化 Pi Package，提供终端状态与工具渲染、会话预设、`/fire-review` 对抗审查、`/fire-master` 进程内子代理委派和 `/fire-watch` 观察员。指挥官与观察员的新会话状态由配置决定，裸命令只翻转当前会话；各模块由功能开关独立注册，关闭任一模块不会改变其余模块。

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

私人运行配置的运行默认是功能全开；公开配置模板采用安全默认，只启用纯本地界面与会话功能，依赖个人认证或通知地址的 Provider、Bark 通知、审查、子代理委派和观察员默认关闭，配置完成后再开启。审查与观察员的模型必须显式写入运行配置，否则对应功能拒绝启动。缺少运行配置时，FireCode 会关闭可选功能并在会话启动时警告；配置模板本身不会被运行时读取。

## 开发

需要 [Bun](https://bun.sh/) 和一个 pi-mono checkout。开发版 `pi` 在 `PATH` 中时，测试会自动定位它；否则设置 `PI_PACKAGES_DIR` 为 pi-mono 的 `packages/` 目录。

```bash
bun test
```

模块边界、状态机约束和领域术语见 `AGENTS.md`、各模块的 `AGENTS.md` 与 `CONTEXT.md`。
