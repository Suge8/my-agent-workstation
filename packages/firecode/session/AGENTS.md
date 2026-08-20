# session：会话层功能

预设、改名、`/tokens`、Bark 通知、herdr 身份投影、工作火焰。各功能互不依赖，关掉任何一个不影响其余。

| 文件 | 职责 |
| --- | --- |
| `presets.ts` | 预设切换：模型、思考等级、工具集、附加指令 |
| `rename.ts` | `/rename` 与 `keys.rename` 改会话名 |
| `herdr-display.ts` | 会话身份投影到 herdr 的 agent 副标题 |
| `stats.ts` | `/tokens` 扫会话 jsonl 统计 token 与成本（源自 pi-token-stats, MIT） |
| `bark.ts` | 任务落定时推 iPhone Bark 通知 |
| `working-flame.ts` | 工作回合内 aboveEditor 居中多行火焰 widget |

预设名写入会话记录，重开会话只恢复名字与附加指令，不重放模型和工具切换。

bark：同会话固定 id 新顶旧，有子代理待拍板升 timeSensitive（只读 `master/state.ts` 持久化），Worker 静默。

working-flame：高随终端自适应 3–10 行，宽不够逐级降高；回合内隐藏 Working 文本行，订阅占用频道在审查
活跃期退让。

## herdr-display

把 pi 单向投影到 herdr 的 agent 副标题：`pane.report_metadata` 的 `display_agent` 写 `pi·模型/思考等级`，
`title` 写会话名，同一请求的 `tokens.session` 再把会话名供给侧边栏行布局（herdr 侧边栏只消费自定义 token，
用户 herdr 配置的 pi 行布局引用 `$session`）。

workspace、pane label 与 tab label 都归 herdr、用户或 Master 管；FireCode 不写这些持久名称——tab 是多 pane
共享状态，而 herdr 没有条件 rename/CAS 与清除自定义名的接口，先检查再 rename 无法消除 split/move 竞态。

改名不从 `rename.ts` 接线，只听宿主的 `session_info_changed`（命令、快捷键、自动命名已在宿主收口），另听
model/thinking 选择。同一身份不重发，只有确认送达才记为已发布，请求串行避免乱序覆盖，失败静默并由下一
事件重试。非 TUI 模式（print/json/rpc）不投影：无头调用不能接管可见会话的显示。只有 `quit` 清空副标题，
reload/new/resume/fork 由新会话覆盖。

没有 feature 开关：herdr 之外（无 `HERDR_ENV`）与 Master Worker 内自我禁用。
