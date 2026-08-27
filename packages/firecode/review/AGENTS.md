# review：`/fire-review` 对抗性审查

多模型并行审、顾问仲裁、checkpoint、结果卡、活动条。零外部依赖：schema 校验是手写纯函数（不引 typebox）。

## 状态与生命周期

`state.ts` 是唯一状态事实源（纯 reducer，零 IO），循环状态只经 reduce() 迁移，副作用全在 `index.ts` 执行器。

reload/new/resume/fork 保留可恢复状态，quit 才落终态。checkpoint 的键白名单由领域类型 `satisfies` 派生：
字段增删不同步会编译失败，这是校验漂移（曾导致终态写不进去、重启后恢复出幽灵审查）的唯一防线。

`session_start` 只恢复 checkpoint，宿主在所有异步 session_start handler 完成后发出的 `resources_discover`
才允许推进；`agent_settled` 由 review 判断能否开审。`agent_start` 另作竞态兜底：若审查仍在跑，先 abort
并等待全部审查会话退出，执行模型才进入 turn_start。

`awaiting_fix` 把修复生命周期 `pending → awaiting_start → running → completed` 写进 checkpoint；reload
会重投未确认完成的反馈，只有 completed 才进入下一审查轮。宿主 `sendMessage` 返回 void，因此反馈用
`agent_start` 确认启动、最终 `agent_end` 确认未以 error/aborted 结束，不靠同步 try/catch 猜异步结果。

质量裁决终态（通过 / 顾问叫停 / maxRounds 用尽）先经 `summarizing` 相：结果卡照发，再投递带反循环
禁令的总结提示（followUp + triggerTurn，agent_start 回执、agent_end 收尾），总结回合结束才落 `settled`；
总结生命周期持久化，reload 重投未确认总结，失败静默收尾不升级；事故终态（取消/超时/基础设施错误/quit）
不烧总结回合。修复反馈、总结提示与状态卡 content 统一包在 `<firecode_review>` 中，details 保持原始卡片数据。
占用标签持有到总结完成，Master 的审查等待自然捕获总结作为最终回复。

已知暴露：修复反馈与总结提示的 followUp 唤起仍走宿主侧门（跳过 before_agent_start，#33 上游缺陷），修复回合内系统提示注入会抖动一次；因 display:false 的隐形投递无前门等价物，接受此暴露待上游修复，不在插件侧绕行。

`outcome.ts` 是外部读取终态判定的唯一入口，checkpoint 格式仍归 review 所有。

## 卡片与活动条

结果卡渲染器始终注册（即使 feature 关闭），使用 pi 原生背景卡与完整 Markdown：通过为绿底，未通过、
终止与异常为红底，其余为紫底；排队相不发卡，开始卡只发第 1 轮，后续轮边界由结果卡轮号承担。reload 与
live 外观一致，渲染器永不抛异常（details 校验失败降级 content 纯文本）。每轮 findings 只完整显示一次；
达到顾问阈值时先显示失败卡，若顾问裁定 stop，终止卡只显示顾问裁决，不再复制同一份 findings。

顾问卡与审查结果卡同构：裁决进标题（顾问指引 · 继续修复），正文首行为粗体模型分节，三段正文标题加粗且
段间补空行（Markdown 把单换行折进同段，不补会糊成一块）；修复相活动条的裁决摘要取「下一步方向」首句
并剥掉加粗星号；顾问相活动条把连败轮数并入标题、正文与审查者行同格式；活动框边框线用宿主 DynamicBorder
组件、品牌橙不变（用户决策：裁决一出即入下一轮，活动条与卡片通道已足够）。

`ui.ts` 沿用 pi-flow `/review` 的活动框与交互：≥ 48 列动态火焰（窄区间收紧边距）、更窄居中退化，
审查者落定即在活动条显示结果摘要，顾问裁决摘要在迁入的修复相活动条显示（落定与相迁移同微任务链，
needs_fix 相无渲染机会）；等待模型时编辑器完全隐藏并禁止输入，esc/Ctrl+C 随时取消审查（顾问阶段 esc
跳过咨询），`awaiting_fix` 相把输入交还用户。按键必须经 keybindings/终端转义序列匹配，不能只比裸 `\x1b`。
无 TUI 的会话照常运行完整审查循环，不访问 UI；取消由会话退出或总体 watchdog 负责，结果卡仍写入会话记录。

`progress.ts` 从 spawn 发布的结构化会话事件派生模型进度、token、当前工具耗时及历史工具行，是纯 UI 态，
不入 checkpoint；最终回复直接取会话事件中的完整 assistant 消息，没有文本流截断层。

## 占用信号

审查活跃期双通道：进程内 `herdr:blocked` 频道驱动 herdr 集成的 blocked 状态（集成只转发状态，message
会被 herdr 丢弃）；标签本体经 `herdr-client.ts` 直接以 `pane.report_metadata` 的 `state_labels.blocked`
投递（source `firecode-review`，实测唯一能同时到达 Master 判定与侧边栏 state_text 的通道）。

标签是租约：持有期带 TTL 定时续约（herdr 无“进程退出即清 metadata”接口，crash 残留靠 TTL 自愈，续约
兼作投递失败重试）；终态、取消、退出时清除，清除失败重试一次后由 TTL 兜底，reload 恢复时重新持有；
该显示信号失败不影响审查。

## 契约与配置

审查政策与 PASS/FAIL 输出契约以 `prompts/review.{zh,en}.md` 为唯一事实源，经 spawn 整体替换系统提示；需求、
关注点、往轮结果和完整会话记录留在 user prompt，记录中的需求照常生效，但不能反向改写审查职责、工具边界与
输出契约。审查会话经 `master/spawn.ts` 创建，使用 memory 持久化、整体替换系统提示，关闭自动扩展、Skill、
模板和上下文注入；项目约定由审查者按 system policy 主动读取适用的 AGENTS.md。每条 FAIL 发现必须六要素齐全（标题、严重程度、问题、违反的约定与期望、证据、验证命令，标签
加粗；校验容忍旧措辞与非粗体），同票混入非法发现整票作废为基础设施错误。往轮发现清单随轮注入顾问裁决
（`prompt.ts`），审查者不得原样重提已仲裁事项——僵尸发现的收敛闭环。

审查者的只读是契约而非能力边界：排除 write/edit 只挡住这两个工具，保留的 `bash` 仍能在项目目录执行任意
命令。保留 bash 是有意的——审查者要跑测试取证；真需要物理隔离得上容器或只读挂载。

config.jsonc 的 `review` 节必须显式完整配置：审查者/顾问模型原子（`provider/model/thinking`）、maxRounds、advisorAfterFailures、
timeoutMinutes、tools、language；公开包不内置依赖个人认证或偏好的模型。缺节、缺字段、解析失败
或该节有任何配置问题时，`/fire-review` 与 checkpoint 恢复都拒绝启动；活动 checkpoint 保持原样，修好配置并
重启后继续恢复——静默回退模型会拿用户没配的模型真实发起调用。
不读 pi-flow 的 config.json。
