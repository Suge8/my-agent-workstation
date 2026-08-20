---
status: accepted
---

# 用 Worker Pool 取代 Team Board

Master 只保留 Worker 生命周期与异步结果回传，不再拥有 Goal、Task、Team Board、消息总线或 Review Gate。调度、模型选择和委派模板属于 Master 提示词；Herdr 适配器只负责启动、追问、观察、停止及恢复 Pi session。这样快任务只承担一次 Worker 启动成本，长任务仍能跨 reload 保持上下文，同时避免把委派升级成任务管理系统。

## 后果

Live Worker 可以转为保留 session 的 Dormant Worker并在之后恢复；quit 或切换 Pi session 时释放本 Master 的 Worker，reload 时恢复观察。多个 Worker 可以并行修改共享 checkout，系统不提供写租约或直接通信，Master 明确承担最终集成与验证责任。复杂工作可以使用独立 planning skill，但 Master 插件不依赖任何 skill。按 ADR-0003，fire-review 不与 Master 交换运行身份或关联身份；Master 只从 Worker 外部发起命令并只读终态判定。
