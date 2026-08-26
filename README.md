# My Agent Workstation

简体中文 | [English](README.en.md)

在 Apple Silicon Mac 上装好一套由 Agent 接手维护的编码工作站：Pi、Herdr、FireCode、Skills、桌面与浏览器自动化，以及配套终端体验。

仅支持 **Apple Silicon、macOS 14 及以上、Zsh**。

## 开始

运行稳定安装入口；它只下载最新 Release：

```bash
curl -fsSL https://raw.githubusercontent.com/Suge8/my-agent-workstation/main/install.sh | bash
```

安装分两段完成：

1. Shell 向导先安装 Pi、Herdr 和 Workstation Skill，不要求你预先配置模型。
2. 运行 `pi`；如尚未登录模型，先执行 `/login`。
3. 告诉 Agent：**“继续配置工作站”**。
4. 按提示完成授权并重启一次 Pi。

Agent 会诊断当前环境、展示计划，并接手其余配置。只有模型 OAuth、API Key、macOS 权限和 SYSTEM 替换需要你本人确认；未认证的模型能力会明确保持关闭，不会被静默替换。

## 装好后

默认推荐配置包括：

- Pi、Herdr、FireCode、现役 Skills 与 Architecture Wiki；
- BCU 桌面控制和隔离浏览器自动化；
- Ghostty、Starship、Fastfetch、Zsh 自动建议与语法高亮；
- 根据已认证供应商生成的模型循环、快捷预设、Review、Master 与 Watcher 配置。

Watcher 默认在每个主会话回合后调用推荐模型；OpenAI priority 默认开启并按供应商规则加价。不接受额外调用时，可在模型选择中禁用 Watcher。以后直接告诉 Agent“检查工作站”“更新工作站”或“修复工作站”即可，所有动作始终收口到同一个 `setup` 控制面。

## 安全与保留

安装器先备份再接管，只更新和卸载自己拥有的内容。用户设置、自定义 FireCode 预设和外部工具会保留；凭据只进入供应商 OAuth 或 macOS 钥匙串，不写入仓库、Shell 配置和状态文件。

已有独立 FireCode 或 Homebrew Herdr 时，安装器会停止并要求明确迁移，不会直接覆盖。卸载后，包管理器安装的 Ghostty、浏览器等外部工具仍会保留。

## 维护者

从检出目录运行 `./setup` 可以预览、应用和验证指定模式。模型替换格式见[模型选择](resources/models/README.md)，发行快照与测试流程见[贡献指南](.github/CONTRIBUTING.md)，安全报告见[安全策略](.github/SECURITY.md)。

本仓库采用 [MIT License](LICENSE)，随附第三方代码保留各自声明。
