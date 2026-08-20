---
status: accepted
---

# Worker 使用 pi 默认工具集，隔离降级为纪律加审查

Worker 以 pi 默认工具集启动（read/bash/edit/write，不再传 --tools 白名单）。开放 bash 后，
两道原有"能力边界"事实失效：herdr CLI 走默认 socket 路径，环境变量清不掉控制能力；
`tool_call` 的 checkout 写入护栏只拦 edit/write，bash 重定向可绕过。与其维持假边界，
不如明确信任模型：系统提示禁令（不碰 herdr、不 git commit/push、不装依赖、不越界写，
Delegation 明确授权除外）+ Worker 自测义务 + fire-review 对抗审查 + Master diff 检查 + git 可回滚。

## 后果

Worker 能自跑测试，红绿循环和审查修复轮的质量与速度显著提升，Master 不再替每个 Worker
跑单测，只做集成层验证。edit/write 的 checkout 路径护栏保留，定位从隔离降级为防误伤。
commit 只由 Master 在集成点执行，靠禁令而非工具缺失保证。曾考虑给 bash 但清 HERDR
环境变量：实测 herdr CLI 无环境变量也能经默认 socket 工作，该方案不成立。真需要物理
隔离仍是容器或只读挂载，不在本插件范围。
