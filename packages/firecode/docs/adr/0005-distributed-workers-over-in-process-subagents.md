---
status: superseded
superseded_by: 0009-in-process-runtime-replaces-herdr
---

# 工人保持 herdr 分布式进程，不改进程内子代理

Worker 保持为 herdr pane 里的独立 pi 进程；否决把委派层重构到进程内子代理方案
（评估对象：@tintinweb/pi-subagents、@gotgenes/pi-subagents、@iiwate/pi-subagents-lite）。
跨进程接缝的可靠性一律用"持久事实源 + 至少一次投递 + 对账"收口，不靠边沿信号：
start 对 busy 有界重试、结果经收件箱（pending/ack）持久化重投、审查终态凭 checkpoint 只读判定。

进程内方案由构造消除了全部接缝故障（无 shell 握手、无 socket 状态上报、投递事务化），
但代价对本插件不可接受：Worker 失去 TUI，`/fire-review` 外部投递的整条自动审查闭环报废；
Worker 与 Master 同生共死，一次 reload 杀光在飞工人的过夜上下文；三个包均启动即注册
3 个工具 schema 且携带 8k–19k 行非必需功能。首次夜跑事故（2026-08-16）的四个根因全部
落在接缝实现缺陷上，无一是分布式本身的固有缺陷；修复合计约二百行。

## 后果

herdr 侧的判定缺陷（agent.start 可用 shell 快照在高负载下瞬态误报）由 herdr 项目自行修复，
本插件的重试窗口只是兜底。工人生命周期只经 subagents 工具是硬纪律：CLI 起的工人是脱管工人，
收不到任何回传，必须经收编流程（退出旧 pi → start 传 session 路径）拉回池内。
该纪律要求能力对等：start 支持 cwd 指定工人工作目录（2026-08-16 夜跑实测，缺此能力时
模型系统性绕道 CLI 在独立 checkout 起工人，孤儿 pane 即其副产物）；目录创建仍归 bash。
未来若出现"无需审查、无需过夜"的轻量并行调查需求，进程内子代理可另行评估，不影响本决策。
