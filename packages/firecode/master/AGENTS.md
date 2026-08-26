# master：进程内多 Agent 主控

新会话按 `master.autoActivate` 注入七命令工具 `subagents` 与池快照查询 `subagents_list`；默认开启。裸 `/fire-master` 翻转当前会话，`/fire-master status` 查看状态；下一次会话仍按配置决定，命令不写回。配置或选型表有误时拒绝激活，不用默认模型代替。

## 运行时

所有子会话只经 `spawn.ts` 创建：它封装 Pi SDK 会话、模型、工具（含只属于该子会话的自定义工具）、扩展、
系统提示、上下文文件与持久化，并以显式角色控制 FireCode 的子会话注册。Worker 使用 file 会话，文件位于主会话目录下的 `subagents/`，不会出现在 `/resume`；会话路径是档案身份的唯一事实源。同一路径只允许一个热会话持有者。

Worker 档案是 v7：`working / idle / reviewing` 三态，另有 `interruptedAt` 与 `reviewNeeded` 两个独立标记；`disposition` 只记录落定事件是否待发落。reload 把在飞状态收敛为 `idle + interruptedAt`，保留会话与审查义务。首次续派会前置现场核对提示。

热冷只属于运行时缓存：空闲会话超时释放，档案与 JSONL 保留；后续 `send` 打开原会话继续。档案存在但文件缺失时明确失败，不创建新会话冒充恢复。`kill` 删除池引用并释放热会话，永不删除 JSONL。

## 工具契约

`subagents` 只有七个命令动作，结构上都要求 Worker：

- `start`：显式指定选型表内的 model、thinking 和短名；可带 cwd、review。
- `send`：只投空闲 Worker；省略 model/thinking 时沿用，显式传入时原地切换。对在飞 Worker 拒绝并提示先 `interrupt`。
- `interrupt`：中止 working 回合，保留会话、义务并产生续跑提醒。
- `review`：只对 idle Worker 显式发起 fire-review。
- `tail`：读取最近外部输入后的预算式轨迹快照，不改变状态。
- `ack`：消除待发落标记；审查义务未履行时拒绝。
- `kill`：移除池引用；实现票完成收口或放弃整票时使用。

`subagents_list` 是零参数查询：模型结果只返回池快照；折叠工具行显示池计数，展开后每个 Worker 一行投影当前工具与耗时、审查轮次进度或落定相对时间。

同时 working/reviewing 的 Worker 最多 15 个；第 16 个 `start` 直接拒绝并回报在飞清单，不排队。名字与 sessionPath 都必须唯一，start/send 的准备过程按 Worker 单飞，kill 赢过迟到的异步写回。

## 投递与义务

落定事件先以 pending entry 写入主会话，再经 `sendMessage` 的 `deliverAs: "steer"` 投递，成功后写 ack；reload 重投 pending 与 ack 的差集。并发落定合并成一条消息，主回合进行中即时送达，主回合空闲时触发新 turn。进入模型上下文的事件与复活自检统一包在 `<firecode_master_event>` 中；details 卡仍使用原始正文与分节格式，错误、回复和审查终态都能预览正文首句。

`review:true` 只把审查义务持久化到票上，不自动开审。义务在 reload、中断和失败后保留；通过或质量裁决停止后消除，`ack` 不能绕过，`kill` 随整票删除。审查时机由指挥官判断，义务存续由代码保证。

提示词注入四项调度纪律：等待类任务派最便宜模型的哨兵票；调查与哨兵票收割要点后立即 kill，实现票保留到收口；存在计划产物时，维护责任随指挥权归指挥官；结果、中断与审查终态自动送达，tail 只按需读取执行细节。

## 隔离与配置

Worker 默认加载全部扩展，可由 `workerExcludeExtensions` 按完整路径或 basename 排除；使用默认四工具。Master 模块在 Worker 会话中只注册 edit/write checkout 守卫，不注册命令、subagents 或生命周期。守卫检查真实路径必须位于当前 checkout；bash 仍是可信能力，最终边界由委派纪律、自测、审查和指挥官验收共同承担。

Master 只跨模块读取 `review/outcome.ts`，并订阅 Worker 会话里的 review checkpoint 事件投影审查进度；bark 只读取 v7 持久化状态，工具行复用共享纯渲染组件。状态变化经 store 的 onChange 驱动状态栏，UI 只投影事实，不在动作调用点补绘。
