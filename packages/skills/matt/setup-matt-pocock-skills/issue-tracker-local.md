# Issue tracker：本地 Markdown

本仓库的 issue 和规格说明以 markdown 文件的形式存放在 `.scratch/` 中。

## 约定

- 每个功能一个目录：`.scratch/<feature-slug>/`
- 规格说明位于 `.scratch/<feature-slug>/spec.md`
- 实现 issue 每个 ticket 一个文件，位于 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 编号——绝不要使用单个合并的 tickets 文件
- 分流状态记录在每个 issue 文件顶部附近的 `Status:` 行中（参见 `triage-labels.md` 获取角色字符串）
- 评论和对话历史追加到文件底部的 `## Comments` 标题下

## 当技能说“发布到 issue tracker”时

在 `.scratch/<feature-slug>/` 下创建新文件（需要时创建目录）。

## 当技能说“获取相关 ticket”时

读取所引用路径的文件。用户通常会直接传入路径或 issue 编号。

## 工单生命周期

任何执行方共用同一套流转，不区分 solo 会话还是被派发的 agent。`Status:` 字符串见 `triage-labels.md`。

- **认领**：动手前把 `Status:` 改为 `<in-progress>` 并保存。已处于 `<in-progress>` 的工单视为他人已认领，不要抢。
- **完成**：本地 tracker 没有合并这一步，改动验证通过后直接把 `Status:` 改为 `resolved`。
- **放弃**：未完成就中止时把 `Status:` 改回 `<ready-for-agent>`，不把工单留在进行中。

## 发布前查重

发布新 spec 或工单前，先扫描 `.scratch/*/issues/` 找重叠，按重叠程度选一个动作：

- **完全重复**：不新建文件，把新信息追加到原文件的 `## Comments`。
- **属于对方范围**：放进对方的 feature 目录，或在 `Blocked by:` 行写上依赖。
- **我们有更好的方案**：改写原文件正文，并在 `## Comments` 记录改动理由，不静默另起一份。
- **需要对方拍板**：只在 `## Comments` 提问，不擅自动手。

## Wayfinding 操作

由 `/wayfinder` 使用。地图是一个文件，每个 ticket 对应一个子文件。

- **地图**：`.scratch/<effort>/map.md` — Notes / Decisions-so-far / Fog 正文。
- **子 ticket**：`.scratch/<effort>/issues/NN-<slug>.md`，从 `01` 编号，正文中包含问题。`Type:` 行记录 ticket 类型（`research`/`prototype`/`grilling`/`task`）；`Status:` 行记录生命周期状态或 `resolved`。
- **阻塞**：顶部附近的 `Blocked by: NN, NN` 行。列出的每个文件都处于 `resolved` 后，ticket 才解除阻塞。
- **前沿**：扫描 `.scratch/<effort>/issues/`，查找开放、未阻塞且未认领的文件；按编号取第一个。
- **认领**：按上方工单生命周期设置 `Status:` 并保存，然后才能进行任何工作。
- **解决**：在 `## Answer` 标题下追加答案，设置 `Status: resolved`，然后将上下文指针（gist + link）追加到 `map.md` 的 Decisions-so-far。
