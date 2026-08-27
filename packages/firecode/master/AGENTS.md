# master：进程内多 Agent 主控

新会话按 `master.autoActivate` 注入七命令工具 `subagents` 与池快照查询 `subagents_list`；默认开启。裸 `/fire-master` 翻转当前会话，`/fire-master status` 查看状态；下一次会话仍按配置决定，命令不写回。配置或角色表有误时拒绝激活，不用默认模型代替。

## 运行时

所有子会话只经 `spawn.ts` 创建：它封装 Pi SDK 会话、模型、工具（含只属于该子会话的自定义工具）、扩展、
系统提示、上下文文件与持久化，并以显式角色控制 FireCode 的子会话注册。Worker 使用 file 会话，文件位于主会话目录下的 `subagents/`，不会出现在 `/resume`；会话路径是档案身份的唯一事实源。同一路径只允许一个热会话持有者。

Worker 档案是 v8：`working / idle / reviewing` 三态，以 `role` 记录派发角色、`model` 与 `thinking` 记录实际原子；另有 `interruptedAt` 与 `reviewNeeded` 两个独立标记，`disposition` 只记录落定事件是否待发落。reload 把在飞状态收敛为 `idle + interruptedAt`，保留会话与审查义务。首次续派会前置现场核对提示。

热冷只属于运行时缓存：空闲会话超时释放，档案与 JSONL 保留；后续 `send` 打开原会话继续。档案存在但文件缺失时明确失败，不创建新会话冒充恢复。`kill` 删除池引用并释放热会话，永不删除 JSONL。异步回写只属于满足 `runtime === active` 的当前 runtime；会话关闭先清空当前 runtime，再释放池、订阅与定时器，迟到任务不写状态、投递、UI 或持久化。

## 工具契约

`subagents` 只有七个命令动作，结构上都要求 Worker：

- `start`：显式指定角色表内的 role 和短名；可用 thinking 覆盖角色原子档，可带 cwd、review。
- `send`：只投空闲 Worker；省略 role 时沿用，显式传入时原地切换角色；thinking 可单独覆盖。对在飞 Worker 拒绝并提示先 `interrupt`。
- `interrupt`：中止 working 回合，保留会话、义务并产生续跑提醒。
- `review`：只对 idle Worker 显式发起 fire-review。
- `tail`：读取最近外部输入后的预算式轨迹快照，不改变状态。
- `ack`：消除待发落标记；审查义务未履行时拒绝。
- `kill`：移除池引用；实现票完成收口或放弃整票时使用。

`subagents_list` 是零参数查询：模型结果只返回池快照；折叠工具行显示池计数与每个 Worker 的「角色·状态」，展开后每个 Worker 一行以角色为主投影当前工具与耗时、审查轮次进度或落定相对时间，模型与思考档降为行尾次要信息。底栏指挥官段同源于池状态（见 statusbar 细则）。

同时 working/reviewing 的 Worker 最多 15 个；第 16 个 `start` 直接拒绝并回报在飞清单，不排队。名字与 sessionPath 都必须唯一，start/send 的准备过程按 Worker 单飞，kill 赢过迟到的异步写回。

## 投递与义务

落定事件先以 pending entry 写入主会话，再经根级 `deliver.ts` 投递，成功后写 ack；reload 重投 pending 与 ack 的差集。并发落定合并成一条消息：主回合进行中投卡片、经宿主 steer 队列在句缝（当前 assistant 与工具结果之后）送达；主回合歇透时改走 `sendUserMessage` 前门唤起（用户消息形态，带完整 `before_agent_start` 仪式，见根 AGENTS.md 硬约束）。进入模型上下文的事件与复活自检统一包在 `<firecode_master_event>` 中；details 卡仍使用原始正文与分节格式，错误、回复和审查终态都能预览正文首句。

`review:true` 是持久化到票上的审查义务，不自动开审；它在 `send`、reload、中断和失败后保留并阻止 `ack`，由审查通过或质量裁决停止消除。`kill` 随整票删除义务。

Master 调度行为与 Worker 行为的唯一事实源分别是 `prompts/master.zh.md` 与 `prompts/worker.zh.md`；修改委派纪律或 Worker 约束时改对应提示词，不在本文复述。

## 隔离与配置

Worker 默认加载全部扩展，可由 `workerExcludeExtensions` 按完整路径或 basename 排除；使用默认四工具。Master 模块在 Worker 会话中只注册 edit/write checkout 守卫，不注册命令、subagents 或生命周期。守卫检查真实路径必须位于当前 checkout；bash 仍是可信能力，最终边界由委派纪律、自测、审查和指挥官验收共同承担。

Master 只跨模块读取 `review/outcome.ts`，并订阅 Worker 会话里的 review checkpoint 事件投影审查进度；bark 只读取 v8 持久化状态，工具行复用共享纯渲染组件。状态变化经 store 的 onChange 驱动状态栏，UI 只投影事实，不在动作调用点补绘。
