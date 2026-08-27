---
status: accepted
---

# 模型原子是配置里指定模型的唯一写法

配置中凡是要指定模型与思考档的位置，都写同一个字符串 `"provider/model/thinking"`：presets 的 `model`、
review 的 `advisor` 与 `reviewers[]`、master 角色表的主模型与 `fallback[]`、watcher 的 `model`。解析在
`config.ts` 的 `parseModelAtom` 一处收口——按最后一个斜杠切出思考档，前半必须仍是 `provider/model`，思考档
必须是已知等级，任一不成立都记为配置问题；类型层只保留一个 `ModelAtom`，运行时仍拿到拆好的模型 id 与思考档。

此前同一份配置有三种写法：presets 拆成 `provider` / `model` / `thinkingLevel` 三个字段，review 与 watcher 用两段式
`"provider/model"` 加同级 `thinking`，master 角色表用三段式字符串；`ReviewModel` 与 `MasterModelAtom` 是两个结构
相同的类型，各带一套解析与校验。三套写法没有语义差别，只让每处新配置都要先确认“这里是哪一种”，也让校验
强度随写法漂移：旧的 `review.*.thinking` 值无效时静默回退 `medium`，watcher 则拒绝启动。

替代方案是保留旧写法并双向兼容，或只统一类型层而不动配置文件。兼容层会把三种写法固化成三套事实源，且必须
永久维护对应的错误信息与测试；只统一类型层则配置文件仍是三种形状，收口没有发生在用户实际编辑的地方。因此
都不采用：旧写法一律拒绝，错误信息直接给出该字段应有的形状。

## 后果

模型选择成为一个可整体复制粘贴的值，新增配置位置不再需要发明写法。校验强度在四处配置上一致：思考档非法、
缺 provider、整字段缺失都会报出问题，watcher 与 review 据此拒绝启动，绝不拿用户没配的模型发起调用。preset 的
模型与思考档也因此原子化——模型切换失败时不再单独改动思考档；presets 节也第一次纳入严格校验，未知字段
（含旧的 `provider` 与 `thinkingLevel`）会被报出。

代价是这次升级不可逆：旧配置在升级后立即报配置问题，运行配置必须手工改写四处才能恢复功能。
