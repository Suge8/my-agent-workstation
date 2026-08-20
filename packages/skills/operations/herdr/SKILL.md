---
name: herdr
description: "控制 Herdr 终端复用器。只有用户明确提到 Herdr，或明确要求使用 Herdr 查看或控制 pane、tab、workspace、命令或 agent 时才使用。不能仅因任务适合后台终端、委派或并行工作就使用。需要在受管 pane 内运行（HERDR_ENV=1）。"
---

# Herdr

Herdr 把终端组织成 workspace、tab 和 pane，能识别 pane 里运行的 coding agent，并通过 `herdr` CLI 暴露当前会话。

发出任何控制命令前，先确认本 agent 运行在 Herdr 管理的 pane 里：

```bash
test "${HERDR_ENV:-}" = 1
```

检查失败就直接说明自己不在 Herdr 内并停止。不要从 Herdr 之外探查或控制聚焦中的 Herdr 会话。

检查通过后，`PATH` 里的 `herdr` 二进制即与当前会话通信。用它查看相邻工作、创建终端布局、启动 agent 和命令、读取输出、等待状态变化。

## 学习当前 CLI

已安装的二进制是命令语法的唯一权威。先运行：

```bash
herdr --help
```

再直接运行命令组（不带子命令）打印相关组的用法：

```bash
herdr agent
herdr pane
herdr workspace
herdr tab
herdr worktree
herdr terminal
herdr notification
herdr integration
herdr session
```

不要用裸 `herdr` 做探索——它会启动或附着 TUI。也不要靠省略参数去试探带副作用的嵌套命令：像 `herdr workspace create` 这类命令带默认值即合法，会真的执行。

多数控制命令返回 JSON。标识符和状态从这些响应里读，不要靠预测。

## 理解布局、pane 和 agent

按任务选择匹配的原语：

- workspace、tab、pane 的拓扑负责组织终端位置。
- pane 命令控制裸终端：shell、测试、服务器、输入和输出。
- agent 命令控制当前占据某个 pane 的已识别 coding agent。

pane 无论是否承载 agent 都存在。`agent start` 要求已有一个可用的 shell pane，绝不会创建、拆分或移动布局。普通进程用 pane 命令；需要 Herdr 校验 agent 身份或解读 `idle`、`working`、`blocked`、`done`、`unknown` 生命周期状态时用 agent 命令。

agent 命令的目标接受唯一的存活 agent 名称，或当前承载该 agent 的 pane ID；不接受 terminal ID 和裸 agent 类型标签。名称需匹配 `[a-z][a-z0-9_-]{0,31}` 且在存活 agent 中唯一。名称跟随当前 pane 的占用者，该 agent 退出、被释放或被替换时名称随之清除。

`idle` 表示 agent 就绪可接收输入，且其 tab 已在聚焦的 Herdr UI 中被看过。`done` 是同一底层空闲状态，但对应未被看过的后台工作完成。聚焦该 tab，或用 focus 命令指向该 pane 或 agent，会标记为已看；CLI 读取不会标记。`blocked` 表示 Herdr 识别到审批或提问界面。`unknown` 表示 pane 里有 agent 但 Herdr 无法可靠分类；它不能证明工作已完成。

## 使用 ID 与调用方上下文

公开 ID 是不透明的稳定句柄：

- workspace：`w1`
- tab：`w1:t1`
- pane：`w1:p1`

关闭的 tab 和 pane 的 ID 不会复用。pane 移入另一个 workspace 后会获得新的 workspace 限定 pane ID。`pane move` 之后，用 `.result.move_result.pane.pane_id` 或存活 agent 名称继续操作；旧值在 `.result.move_result.previous_pane_id` 中报告，只有被移动进程继承的调用方上下文还能解析旧 ID，不要把它当通用 agent 目标。

Herdr 会把调用方上下文注入每个受管 pane：

```bash
printf '%s\n' "$HERDR_WORKSPACE_ID" "$HERDR_TAB_ID" "$HERDR_PANE_ID"
```

pane 命令要指向调用方自身的 pane 时优先用 `--current`。省略目标可能落到 UI 聚焦的 pane 上，而那个 pane 可能属于用户或其他客户端。

发现实时状态：

```bash
herdr workspace list
herdr tab list --workspace "$HERDR_WORKSPACE_ID"
herdr pane current --current
herdr pane list --workspace "$HERDR_WORKSPACE_ID"
herdr agent list
```

创建类响应会给出后续要用的 ID：`workspace create` 返回 `.result.workspace`、`.result.tab` 和 `.result.root_pane`；`tab create` 返回 `.result.tab` 和 `.result.root_pane`；`pane split` 在 `.result.pane` 返回新 pane。

## 启动并协调 agent

默认在当前 tab 里开兄弟 pane、沿用当前工作目录。除非用户明确要求，不要创建 workspace、tab、worktree 或换目录。

用户指定了拆分方向就照做；否则先查看调用方 pane：

```bash
herdr pane layout --pane "$HERDR_PANE_ID"
```

宽 pane 向右拆，窄或高的 pane 向下拆。避免同方向反复拆分产生过窄的列或过矮的行。保持用户焦点留在调用方 pane，并显式保留调用方的工作目录：

```bash
herdr pane split --current --direction right --cwd "$PWD" --no-focus
```

需要时把 `right` 换成 `down`。从 `.result.pane.pane_id` 读取新 pane ID。

可用的 shell pane 必须停在交互式提示符：shell 本身在前台，没有前台命令、编辑器或 agent 在跑。用一个有意义的唯一名称在该 pane 启动受支持的 agent：

```bash
herdr agent start reviewer --kind codex --pane <returned-pane-id>
```

运行 `herdr agent` 查看已安装的 kind 列表和选项。用户要求的 kind 按要求使用。原生 agent 参数只放在 `--` 之后：

```bash
herdr agent start reviewer --kind pi --pane <returned-pane-id> -- <agent-args...>
```

`agent start` 只在 Herdr 于同一 pane 检测到预期 agent 并认为其可接收交互输入后才返回，默认 30 秒启动超时。

通过 agent 界面提交工作：

```bash
herdr agent prompt reviewer "审查当前 diff，只报告可执行的发现。" --wait --timeout 120000
```

`agent prompt` 会按 pane 的实时 bracketed-paste 模式原子地提交文本和编码后的回车；对 working 中的 agent 也可提交（排队语义），给忙碌 worker 追加指令无需等 idle。常规工作用 `--wait` 就够：它等待第一个稳定的 `idle`、`done` 或 `blocked` 状态。不要用 `--until` 重复这些默认值。

从非 working 状态发出的 prompt 必须在五秒内产生可观测的生命周期变化，否则 Herdr 返回 `agent_prompt_stalled` 而不是无限等待。这个等待跟踪的是生命周期状态而非单个回合：如果 agent 已在工作，当前回合的完成也可能满足它。

`--until` 只用于特定状态的工作流，比如等一个已在运行的 agent 请求输入：

```bash
herdr agent wait reviewer --until blocked --timeout 120000
```

不带 `--until` 的独立 `agent wait` 与 `agent prompt --wait` 使用相同的稳定状态默认值。

交互式 agent 界面控件用逻辑按键：

```bash
herdr agent send-keys reviewer esc
herdr agent send-keys reviewer ctrl+c
```

Herdr 在写入任何字节前会校验所有按键。通过已解析的 agent 读取结果：

```bash
herdr agent get reviewer
herdr agent read reviewer --source recent-unwrapped --lines 120
```

等待失败或返回 `blocked` 时，先看 `agent get` 和 `agent read` 再决定发送什么输入。只有在刻意做裸终端控制时才用 pane 界面。

## 在另一个 pane 运行普通命令

按同样的几何规则开兄弟 pane，保留调用方工作目录，不改变用户焦点：

```bash
herdr pane split --current --direction right --cwd "$PWD" --no-focus
```

从 `.result.pane.pane_id` 读取新 pane ID，然后运行并检查命令：

```bash
herdr pane run <returned-pane-id> "just test"
herdr pane wait-output <returned-pane-id> --match "test result" --timeout 120000
herdr pane read <returned-pane-id> --source recent-unwrapped --lines 120
```

`pane run` 原子地发送命令文本和回车。`pane wait-output` 会立即搜索所选快照，已有输出也能匹配。字面子串用 `--match <text>`，Rust 正则用 `--regex <pattern>`。省略 `--timeout` 表示无限等待。

按任务选择读取源：

- `visible`：当前渲染的视口。
- `recent`：最近渲染的输出，含软换行。
- `recent-unwrapped`：最近输出且软换行已合并；日志和文字记录优先用它。
- `detection`：用于 agent 检测的纯文本底部缓冲快照。

颜色和终端样式本身是证据时用 `--format ansi`，否则用 text。

`--lines` 会向 Herdr 请求 pane 可用屏幕和宿主回滚缓冲中的更多行。若增加行数仍无法显示已完成响应的更多内容，pane 可能正在备用屏上运行 agent。退出备用屏的行不会进入 Herdr 宿主回滚缓冲，因此增加行数无法恢复这些内容。

仍读不全时，让 agent 把完整回复以 Markdown 写入临时目录并只回复文件路径，然后直接读文件。这只是兜底手段，不要在最初的 prompt 里就要求文件输出。

## 安全与协作规则

- 后台工作用 `--no-focus`，除非用户要求切换上下文。
- 用 `--current`、显式 pane ID 或唯一 agent 名称；不要依赖其他客户端聚焦的 pane。
- ID 从 JSON 响应解析，不要按侧栏顺序或示例推导。
- 不要关闭不是你创建的 workspace、tab、pane 或会话，除非用户明确要求。
- 绝不从活动会话运行 `herdr server stop`，除非用户明确要停止服务器及其 pane 里的进程。
- 绝不杀掉 Herdr 主进程。需要隔离服务器的实验用命名测试会话。
- CLI 服务器错误以 JSON 输出到 stderr，退出码 1；CLI 语法错误退出码 2。
