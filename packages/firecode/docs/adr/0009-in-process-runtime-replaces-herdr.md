---
status: accepted
---

# 进程内运行时取代 herdr 分布式 Worker

Master Worker 改由主 Pi 进程内的官方 SDK 子会话承载，统一通过 spawn 基建创建；删除 pane、shell 就绪、报到轮询、身份对账与跨进程恢复。Worker 会话以 JSONL 持久化在主会话目录下的 `subagents/`，档案中的 sessionPath 是唯一身份；父 Pi 退出时热会话全停，恢复主会话时只恢复冷档案，不自动唤醒模型。

本决策取代 ADR-0005。其第一条否决理由是“进程内 Worker 会让 `/fire-review` 闭环报废”。#9 与 PR #10 先将 review 入口及取消路径 headless 化；随后 spike 用真实 sonnet/opus 审查者验证五条闭环：checkpoint 落盘、FAIL 后修复回合完整执行、中断后同一 runId 续审、两轮后 `readReviewOutcome` 返回 passed、已跟踪文件零改动。headless 会话绑定 FireCode 扩展、真实 Worker 回合、模型解析与认证也均实跑通过。因此失败来自 FireCode 自己的 TUI 入口 guard，不是 Pi SDK 的能力边界，“闭环报废”断言不成立。

第二条否决理由是 reload 会杀掉在飞 Worker。新运行时明确接受这个差异：reload 把在飞回合记为中断，JSONL、审查义务和票档案保留；首次 send 透明打开原会话，并前置“先核对 git 与现场”的续跑提醒，避免重复副作用。它不承诺跨主进程继续烧模型，而是保证中断可见、义务不灭、上下文可续。用户知情接受该语义，换取父进程退出即全停、无幽灵进程与零传输层对账。

状态机从 v6 的 `starting / working / blocked / idle / reviewing / dormant` 六态收敛为 `working / idle / reviewing` 三态，加 `interruptedAt / reviewNeeded` 两个正交标记；待发落另由 disposition 记录，不参与运行状态。`starting` 被 start 的单飞准备过程吸收，尚未建档不构成可恢复状态；`blocked` 不再从终端集成推断，子代理提问以普通落定结果交给指挥官；`dormant` 被热/冷缓存细节取代，冷档案仍是同一个 idle Worker；`sleep` 动作随 dormant 删除，保留票用 ack，释放缓存自动发生，删除票只用 kill。

工具面固定为 start / send / interrupt / review / tail / ack / list / kill。并发 admission 上限为 15，超出直接拒绝并回报在飞清单；send 对冷 Worker 透明复活，对在飞 Worker 拒绝并要求先 interrupt。落定事件先持久化 pending，再以 steer 即时投递并写 ack；并发结果合并，reload 重投差集。

## 后果

插件只有一套子会话启动基建和一个 v7 状态事实源，不再承担终端布局、shell 竞态、传输重试或身份漂移。热会话只是缓存，kill 只删池引用、不删历史 JSONL；档案存在而文件缺失时明确失败，不创建新会话冒充恢复。v6 状态直接丢弃，不写迁移与回退；旧运行时进程由用户一次性手动清理。review 的 Herdr 占用标签与 session 的身份投影是独立展示能力，不属于 Master 运行时，继续保留。
