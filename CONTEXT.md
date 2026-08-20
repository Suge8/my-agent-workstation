# 领域术语

本文件是仓库级术语的单一事实源；模块专属术语留在模块自己的 `CONTEXT.md`。

**My Agent Workstation**：面向 Apple Silicon macOS 的工作站安装与维护仓库。

**Pi**：用户与编码 Agent 交互的终端宿主，负责会话、模型和 Package 加载。

**Herdr**：管理终端 Workspace、Tab、Pane 和 Agent 运行状态的本地服务；通过官方 integration 与 Pi 连接。

**FireCode**：运行在 Pi 中的工作流定制层，提供预设、状态显示、对抗审查和多 Agent 主控。其内部术语以 `packages/firecode/CONTEXT.md` 为准。

**Skill**：Agent 按任务触发的操作说明及其按需参考资料。

**BCU（Better Computer Use）**：由 CLI、用户级 Broker 和原生 Helper 组成的 macOS 桌面控制工具。

**agent-browser**：供 Agent 导航、操作和调试网页的浏览器自动化 CLI。

**CloakBrowser**：浏览器自动化默认使用的隔离浏览器运行时，与日常浏览器环境分开。

**Ghostty**：可选终端，用于承载 Pi 与 Herdr 的快捷键体验。

**Starship**：可选 Shell 提示符，不负责插件管理。

**Fastfetch**：可选的终端系统信息展示工具。

**Zsh 插件**：直接加载的自动建议与语法高亮组件，不引入 Shell 框架或插件管理器。

**完整同款**：选择全部推荐组件的安装模式；系统权限、OAuth、密钥和完整提示词替换仍由用户确认。

**核心安装**：只安装 Agent 运行所需核心组件的模式。

**自定义安装**：由用户逐项选择组件的模式。

**受管理内容**：由本仓库创建或明确接管、可被更新与卸载的配置和文件；其余用户配置不属于本仓库。

**维护源**：维护者本机的 FireCode、现役 Skills 与 SYSTEM 原始内容。

**发行快照**：维护源经过排除和脱敏后保存在本仓库中的副本。

**同步**：维护者将维护源单向写入发行快照并验证的本地操作；不包含提交或发布。

**用户更新**：用户从最新稳定 Release 更新受管理内容，不直接读取维护源。

**模型档案**：模型选择的单一事实源，用于派生 Pi 与 FireCode 的模型配置。

**最新稳定版**：上游正式稳定渠道的最新版本，不含 main、HEAD、preview 或 nightly。
