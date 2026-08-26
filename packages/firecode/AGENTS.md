# FireCode

pi 的个人定制层：启动横幅、底部状态栏、工具行渲染、预设与重命名、Anthropic OAuth 归因、`/fire-review`
对抗性审查、默认激活的 `/fire-master` 多 Agent 主控与 `/fire-watch` 观察员。

单一入口 `index.ts` 只做一件事：按 `config.features` 逐个调 `registerX(pi)`。每个 register 封闭自己的运行
状态，关掉任何一个不影响其余；跨模块接缝只有七条：Master 只读调 `review/outcome.ts`，bark 只读调
`master/state.ts` 的持久化状态，Master 复用 `tools/line.ts` 纯渲染组件画自己的工具行，Review 与 Watcher 经
`master/spawn.ts` 起子会话，Watcher 订阅 review 发布的占用频道判静默、blocker 唤起时调 `session/bark.ts` 推送。

## 模块

| 路径 | 职责 | 细则 |
| --- | --- | --- |
| `header.ts` | 会话启动横幅，窄终端退化为一行 | |
| `statusbar/` | 底部两行：会话身份 + 模型/额度/上下文/缓存/速度 | [statusbar/AGENTS.md](statusbar/AGENTS.md) |
| `tools/` | 接管默认 4 工具（read/bash/edit/write）的渲染，含连续行轨道；不包装 grep/find/ls——原版 pi 注册即激活，包装即强制打开 | |
| `session/` | 预设、`/rename`、`/tokens`、Bark 通知、herdr 身份投影、工作火焰 | [session/AGENTS.md](session/AGENTS.md) |
| `review/` | `/fire-review` 对抗性审查：多模型并行审、顾问仲裁、checkpoint、结果卡、活动条 | [review/AGENTS.md](review/AGENTS.md) |
| `master/` | `/fire-master`：进程内 Worker 池、七命令与独立查询、当前动作投影、steer 投递与审查义务 | [master/AGENTS.md](master/AGENTS.md) |
| `watcher/` | `/fire-watch` 观察员：turn 增量评估与 nit/concern/blocker 三档投递 | [watcher/AGENTS.md](watcher/AGENTS.md) |
| `provider/claude-sub.ts` | Anthropic OAuth 请求补 Claude Code 归因头 | |
| `provider/openai-native/` | 请求层：OpenAI verbosity、OpenAI/xAI Fast（service_tier=priority）、可选原生压缩 | |
| `flame-frames.ts` | 品牌火焰帧素材（任意高度缩放），供审查活动框与 working 火焰共用 | |
| `herdr-client.ts` | herdr socket 短连接客户端，herdr-display 与 review 占用标签共用 | |
| `format.ts` `theme.ts` | 共享的宽度/文本格式化与品牌配色、阈值分级 | |
| `config.ts` | 从 Pi Agent 目录解析唯一运行配置 | |

改 `review/` 或 `master/` 前先读对应细则页：两者的状态机、持久化与投递契约都有事故换来的硬约束。

## 硬约束

带背景的卡片里禁用 pi-tui `TruncatedText`/`truncateToWidth`：其省略号带 `\x1b[0m` 全量重置，会在截断点掐断
外层背景色（上游 #4894 已报被拒修）；单行截断一律用 `format.ts` 的 `clip`。

`tools/grouping.ts` 依赖 pi 内部组件树与原型 patch，是与宿主耦合最紧的一处，升级 pi 时优先检查。

## 配置

唯一运行配置是 Pi Agent 目录（由官方 `getAgentDir()` 解析，含 `PI_CODING_AGENT_DIR` 覆写）下的
`extensions/firecode/config.jsonc`；安装流程当场生成完整私人配置。公开的 `config.example.jsonc` 是维护者当前的
完整推荐配置：除 Bark 外功能全开，Master 与 Watcher 在新会话自动激活；Watcher 每回合调用模型，priority 按
供应商规则加价。配置模板只是起始样例，不参与运行时读取。缺失运行配置时关闭可选功能，并在每次
`session_start` 警告一次；运行中补上配置也需重启 Pi 才生效。

不要新建 keys.json，也不要读项目级配置。快捷键启动时绑定，改完需重启；`ctrl+f` 只改 `openai` 节，其它注释
保留。未知字段、嵌套未知字段与类型错误都报配置问题；`review`、`master` 与 `watcher` 节有问题时对应功能
拒绝启动而不是回退默认——静默回退会拿用户没配的模型真实发起调用。

## 测试

```bash
bun test
```

`tests/loader.ts` 从 `PATH` 中的开发版 `pi` 定位 pi-mono；非开发版安装通过 `PI_PACKAGES_DIR` 指向其
`packages/`。loader 把当前仓库复制到临时目录并改写宿主包导入，供需要运行时值的用例使用。
