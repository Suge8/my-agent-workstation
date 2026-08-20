# master：`/fire-master` 多 Agent 主控

按需注入 `subagents` 工具，启动、发消息、中断、审查、读近况、休眠与移除 Herdr Worker。
Master 默认休眠：普通 Pi 不带 `subagents`，`/fire-master` 后只追加这一个工具。没有 Goal、Task 或任务板。

## 接口与选型

`subagents` 是唯一接口：start / send / interrupt / review / tail / ack / list / sleep / kill（动作集来历见 ADR-0007）。
工具名不带 herdr——名字里的 herdr 会把模型引向 CLI 逃生路径（实测夜跑事故根因）；guidelines 另有硬禁令：
禁止 bash herdr 管子代理，脱管子代理（在 herdr 里跑但不在池内）零回传，发现即收编（退出旧 pi → start 传
session 路径，ADR-0005）。

提示词决定何时委派、模型选型（依据 config 选型表，首次派发前把分波计划和每票模型一次性列给用户确认）
和委派文本；工具只负责 Worker 生命周期、审查发起和异步结果回传。选型本身由代码强制：新建 Worker 的
model 与 thinking 必须显式传，省略与表外模型在投递前拒绝并回带选型表，只有唤醒池内 dormant 沿用档案——
提示词的“显式传”打不过参数的“可省略”，静默继承会拿最贵的一档真实开工。

config.jsonc 的 `master.models` 是必填选型表（模型 id + 默认 thinking + 适用场景），注入 subagents 工具提示词；
公开包不内置依赖个人认证或偏好的模型。该表缺失、为空或有配置问题时 `/fire-master` 激活与恢复拒绝启动——
选型表错误会拿错模型真实发起 Worker。

start 的 `cwd` 参数指定子代理工作目录（绝对路径、必须已存在，校验失败拒绝启动；目录随档案持久化，休眠
恢复回到同一 checkout）——能力缺口会把模型逼上 CLI 逃生路径（ADR-0005）；guidelines 不教 worktree，共享
checkout 仍是默认。`agent.start` 对 `agent_pane_busy` 退避重试 15s（herdr 进程快照高负载瞬态误判；shell
标记已匹配故 busy 必为瞬态），窗口用尽附 pane process-info 证据。

## 结果回传与发落

结果用 custom follow-up message 投递，事件卡默认紧凑（每事件一行「标题 — 正文首句」按宽截断，ctrl+o
展开全文；content 给模型、details 给渲染，无 details 的旧消息降级全文）；list 的工具行把池快照回写行尾
（名字 + 中文状态词，空池显「空」，同 edit ±diff 通道）；事件不携带模型/session 等静态身份——进场一次
（start 返回值）、按需重查（list），事件只装增量。

不轮询、不拼进用户输入；投递前先以 pending entry 落 Master 会话、投成写 ack（收件箱至少一次语义），
crash/reload 后未 ack 差集在恢复激活时重投，重复投递无害；Master 回合进行中到达的结果暂存，agent_settled
后合并成一条再投（宿主 followUpMode 默认一回合一条，拆投会裂成多回合）。

`tail` 读子代理近况：从会话叶子沿父链倒取，遇最近一次外部输入（user 消息或 fire-review 的 custom_message，
后者是子代理会话里 custom_message 的唯一来源）或 4000 字符预算用尽即止，谁先到算谁；边界本身只带 250 字符
做锚点（不知道它在回应什么就读不懂轨迹，但委派正文不该吃预算），单条工具调用与结果各 300 字符封顶（预算
要买到步数而不是日志），异常停止原因提到最前。starting 之外全状态可读（休眠子代理的会话文件仍在磁盘上），
working 时读到的是已跑完的部分——它是只读快照，提示词明禁拿它轮询进度；读也不消耗发落标记（看一眼
就算处置是 ADR-0007 那类假成功）。

落定类事件（结果/中断/审查终态/续跑提醒）送达即要求发落：回合内无 send/review/sleep/kill/ack 则下个回合
边界注入一次可见提醒，提醒后仍不发落升级为用户通知收口；发落标记持久化，ack 对无待发落标记的非 idle
子代理报错（把它误当暂停是真实事故，ADR-0007），活性归代码、发落决策归模型。

## 状态机与中断

Live Worker 可 sleep 为保留上下文的 Dormant Worker，kill 才删除引用；两者对运行中子代理都会立即中止并收
pane。Herdr 报 `blocked` 时保持阻塞态并把 `state_labels` 中的问题通知 Master，Master 用 send 回答后继续。
`idle` 与未查看后台结果 `done` 都保留为可追问的 Live Worker，最终 assistant 只有以 `stop` 结束（LLM 停止
原因）才回传完成；`length`、`toolUse`、非中断的 `error`、缺失回复均按失败回传。

中断（`aborted` 或 abort 字样的 `error`，即 interrupt 指令、esc 手动介入或连接异常）不按失败回传也不消耗
审查意图：事件告知 Master，插件续监动静（接手则结果照常回流），五分钟无动静再发自动续跑提醒让 Master
续派；中断时刻随档案持久化，reload 重挂续监与剩余计时（ADR-0006）。interrupt 发 esc 主动打断 working
子代理，走同一条中断结算路径，事件文案注明是指令中断（在飞标记不持久，reload 后退化为外部中断文案，
无害），就绪信号经中断事件回传。普通工作监听用无截止事件等待，连接失败后保持 `working` 并退避重挂。
start 传 Dormant 名或 session path 即可恢复。

## 布局与命名

新 Worker 优先在当前 Worker tab 内 split（2×2 象限切，避免嵌套同向切把后来者挤成 1/8 宽），每 tab 最多 4 个，
满或 split 失败才建 tab；单子代理 tab 标签是其显示名，第二个子代理加入后改组名「子代理」；不 rebalance；
Dormant 恢复与新建同一套布局（cwd 随档案持久化，混住同 tab 无碍）。中止或清理共享 tab 里的子代理只收其
pane，不连坐关 tab；reload 时旧运行时静默退场（等在飞启动退出、不关 shell 不写状态），现场由新运行时
reconcile。新 tab 用 zsh precmd 标记等真实 shell prompt。

命名四层统一：pane/tab/Pi 显示名为 `任务名-模型名`（Pi 前缀 `↳`，不截断），Herdr agent 名是其净化版
（字符集硬约束 [a-z0-9_-]、32 封顶，点号降为 `-`）；start 必须提供短任务词，没有 worker-N 退化；
pane 命名失败不影响启动只通知。

## 审查意图

只有 `idle` Worker 可 review，且 review 关闭或配置有误时 action 在投递前拒绝（否则命令会退化成普通模型输入）。
审查意图在 `start`/`send` 的 `review:true` 参数声明（跟任务走不跟渠道走，唤醒待命不设）、持久化进 Worker
档案；意图只在 review 确认启动（状态变化或 runId 推进）时消耗——投递失败保留意图并通知，reload/reconcile
与休眠恢复都凭档案续上补审；投递窗口内的审查票拒绝 send（blocked 提问的回答通道不受影响；中断态不是投递
窗口，审查票的 send 在中断态放行以保自动续跑可执行）。Worker 成功落定即自动发起补审并回传终态（含轮数与
顾问裁决首行），失败落定不审、意图保留；派发时即验 review 可用性，不可用直接拒绝 start。无推断、无服从性
赌博——这是自审模型五轮审查后的第一性收口：生命周期完整复用 review action 路径，工作监听只把带占用标签
（`review/outcome.ts` 的 REVIEW_OCCUPANCY_LABEL）的 blocked 归类为外部审查占用（转 reviewing 等终态）而非
Worker 提问。

代码固定投递字面 `/fire-review`（`prompt --wait` 等投递后状态变化，stalled 时以 runId 是否推进判定是否真的
启动），状态转为 `reviewing`，在 `/fire-master status` 和状态栏显示并拒绝 send。审查监听只等 `idle` / `done`，
跳过 `blocked` 占用态；若结算时 outcome 仍是 in_progress（占用信号失效）则退避重挂直到终态，reload 按同样
规则恢复；终态经 `review/outcome.ts` 读取并连同最终回复回传（passed / stopped=质量裁决终止，含 maxRounds
用尽 / failed=error·cancelled·timed_out 等审查未完成，不弱化成停止）。fire-review 不与 Master 交换运行身份
或关联身份；Master 只从外部发起命令并只读判定。

## 委派纪律与 Worker 隔离

轻重之分 = review 参数：重要实现票 start 时设 `review:true`；有可测行为变更的实现票默认 `/skill:tdd ` 开头
并把 spec/Ticket 已定的接缝与验收写进委派文本（接缝在计划层确认，子代理不回头询问），调查/文档/收口/纯
重构用普通说明。委派技能前缀由 start/send 代码白名单强制（仅 `/skill:tdd `，`/skills:` 拼写错误一并拦截；
提示词禁令实战失效 26 次后改为机制），Master 不用 `/skill:implement`（内含自审，是用户 solo 技能）。
斜杠技能只在文本开头且后跟空格才展开，写错静默失效。

本插件不依赖 planning skill；多个 Worker 可并行写共享 checkout，Master 负责最终集成与验证。仅当已有本次
流程的 `.scratch/` Tracker 时，Master 才按 Ticket 阻塞边分波、并行首批调查、逐波集成验证并完成删票；路径
重叠是阻塞边判据之一：同文件并行编辑在提交前就互毁，重叠票串行或合并，不得同波并发；审查自动修复期间
不 start/send，整体收口派专门 Worker，Master 只派活、分析和决策。没有 Tracker 的日常委派仍按需直接进行。
子代理 commit 带路径且只含自己的改动、禁止 push，指挥官在集成点验证后统一 push。

Worker 带 `FIRECODE_MASTER_WORKER` 启动，用 pi 默认工具集（read/bash/edit/write，ADR-0004），能自跑测试；
隔离是纪律不是能力边界：系统提示禁令（herdr、git push、装依赖、越界写；commit 限自己路径）+ 自测义务 +
fire-review + Master diff 检查 + git 回滚。`tool_call` 仍把 edit/write 限在当前 checkout（含真实路径解析），
定位是防误伤——bash 可绕过，不伪装成隔离；真需物理隔离得上容器或只读挂载。

Worker Pool 状态 schema 只认 v5（无用户，不留旧版兼容），用 mode 0600 的单个文件原子覆盖，不向 Pi session
追加快照；reload 恢复观察，quit/new/resume/fork 和 `/fire-master off` 清理。

状态栏指挥官行由 store 变更驱动（MasterStore onChange，落盘后通知），UI 是状态的纯投影；禁止在动作调用点
手动补重绘——散落调用点必漏异步转态（send 后卡「闲」、自动补审不显「审」是真实事故）。唯一例外是
激活末尾的首绘（resume 期间 runtime 未就位，onChange 早退）。
