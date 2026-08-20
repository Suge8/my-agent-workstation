# My Agent Workstation

[English](README.md) | 简体中文

为团队复刻同一套 Apple Silicon Mac 编码 Agent 工作站：一条命令进入中文向导，已有组件只更新或修复，不重复堆配置。

仅支持 **Apple Silicon、macOS 14 及以上、Zsh**。

## 安装

稳定版入口只下载 GitHub 最新 Release，不跟随 `main`：

```bash
curl -fsSL https://raw.githubusercontent.com/Suge8/my-agent-workstation/main/install.sh | bash
```

维护者也可从检出目录运行 `./setup`。向导提供：

- **完整同款（推荐）**：核心环境、桌面与浏览器自动化、Ghostty 和终端体验。
- **核心安装**：Pi、Herdr、FireCode、现役 Skills、SYSTEM 与模型配置。
- **自定义**：逐项选择 BCU、浏览器、终端、Helium 和搜索。

“一键”不会绕过 macOS 权限、模型 OAuth、API Key 或 SYSTEM 完整替换确认。

## 包含什么

- **Pi**：Agent 会话、模型和 Package 宿主。
- **Herdr**：管理 Workspace、Tab、Pane 和 Agent 状态；它是必需运行条件。安装器使用官方校验脚本跟随最新稳定版，并用受管理 LaunchAgent 在登录时启动；Homebrew Formula 滞后时不拿旧版冒充最新。
- **FireCode**：提供预设、状态栏、对抗审查和多 Agent 主控；公开配置见 [FireCode 说明](packages/firecode/README.md)。
- **Skills**：按任务加载的专业操作说明；不分发归档、`search-skills`、eval、缓存或 vendor。Architecture Wiki 随 Release 携带中英双语资产，但安装时只激活一种语言。
- **BCU**：独立 CLI、Broker 与原生 Helper，用于控制 macOS 应用。上游归属见其 [package README](packages/better-computer-use/README.md)。
- **agent-browser + CloakBrowser**：隔离的网页自动化环境。Helium 只是可选日常浏览器。
- **Ghostty + Starship + Fastfetch**：可选终端、提示符和开局系统信息；自动建议与语法高亮由两个 Zsh 插件直接提供，不安装 Oh My Zsh。

## 维护

```bash
./setup doctor --json          # 只读诊断
./setup plan --mode full       # 预览动作
./setup verify                 # 验证已选能力
./setup update --yes           # 更新最新稳定版和受管理组件
./setup repair --yes           # 按诊断补缺
./setup uninstall              # 移除受管理内容，保留备份和外部工具
./setup configure-search       # 把 Brave/Exa 密钥写入 macOS 钥匙串
```

安装后的 `workstation-setup` Skill 会调用同一套命令，不复制安装逻辑。Brave 与 Exa 优先读取环境变量，其次读取 macOS 钥匙串；Context7 使用自身 OAuth。密钥不会进入 Shell 配置、状态文件或仓库。

模型供应商先由 `pi auth check --no-refresh` 检测。已认证模型会生成 Pi、FireCode 预设、Master 与 Review 配置；完整同款只有在认证或显式模型替换能组成完整推荐配置时才开始变更，否则明确停止。需要替换推荐模型时按[模型选择说明](resources/models/README.md)通过 `--selections <json>` 提供选择，安装器会保存并在更新时复用；用户修改过的受管理 Pi/FireCode 字段、无关设置和自定义预设保持不变。

Agent 会按对话语言传 `--architecture-language zh|en`；纯 Shell 非交互安装默认中文，选择会写入状态并由更新、修复沿用。再次显式传参可原子切换，Pi 始终只加载一个变体。

所有改动先备份。Ghostty 与 Zsh 只插入带标记的受管理片段。首次非交互安装仍需明确选择保留或替换 SYSTEM；未被用户修改的受管理 SYSTEM 会随稳定版更新，用户改过后保持原样，直到明确选择保留或替换。已有独立 FireCode 时安装会停止，只有明确传入 `--migrate-firecode` 才迁移；已有 Homebrew Herdr 的迁移同样需要 `--migrate-herdr`。

卸载只移除本工作站拥有的内容。agent-browser、CloakBrowser、Ghostty、Starship、Fastfetch 和 Helium 等包管理器工具会保留。

## 维护发行快照

```bash
./maintain sync
```

该命令只从干净且已提交的独立 FireCode、现役 Skills、Architecture Wiki 和 SYSTEM 生成快照，并打印各源提交号。`.pi` 中与 SYSTEM 无关的修改不会阻塞。需要时可用 `--firecode`、`--skills`、`--architecture` 和 `--system` 指定维护源；命令不会拉取、提交、打标签、推送或发布。

## 开发验证

```bash
bun run test
bun run check:shell
npm run test:bcu
```

参与贡献请阅读 [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md)，安全报告见 [.github/SECURITY.md](.github/SECURITY.md)。本仓库采用 [MIT License](LICENSE)，随附第三方代码保留各自声明。
