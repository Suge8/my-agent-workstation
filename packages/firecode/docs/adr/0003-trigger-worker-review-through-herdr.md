---
status: superseded
superseded_by: 0009-in-process-runtime-replaces-herdr
---

# 经 Herdr 从外部发起 Worker 审查

Master 只对空闲 Worker 经 Herdr 投递字面 `/fire-review`，再等待 Worker 回到 idle 或 done；审查中的占用态不会触发结算。投递前先快照 review 模块导出的只读判定，结算时必须观察到新的 runId，旧终态不能充当本次结果。审查结束后，Master 仍通过该只读入口读取 Worker session，不自行解释 checkpoint。Master 与 fire-review 不交换运行身份或关联身份。

## 后果

Master 在审查期间保持可对话，不能向 reviewing Worker 追问；reload 后按同一状态过滤恢复监听。命令发起和监听失败会显式回传，终态判定与 Worker 最终回复一起返回。依赖方向只允许 Master 调用 review 的只读判定入口；review 不感知 Master，也不为 Master 发布专用事件。
