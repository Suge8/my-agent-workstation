# Issue tracker：GitHub

本仓库的 issue 和规格说明位于 GitHub issue 中。所有操作都使用 `gh` CLI。

## 约定

- **创建 issue**：`gh issue create --title "..." --body "..."`。多行正文使用 heredoc。
- **读取 issue**：`gh issue view <number> --comments`，使用 `jq` 过滤评论并获取标签。
- **列出 issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，配合适当的 `--label` 和 `--state` 过滤器。
- **评论 issue**：`gh issue comment <number> --body "..."`
- **应用 / 移除标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭**：`gh issue close <number> --comment "..."`

从 `git remote -v` 推断仓库；在 clone 内运行时 `gh` 会自动完成此事。

## 将拉取请求作为分流入口

**PR 作为请求入口：否。**（如果本仓库将外部 PR 视为功能请求，则设为 `yes`；`/triage` 会读取此标志。）

设为 `yes` 时，PR 使用与 issue 相同的标签和状态，通过对应的 `gh pr` 命令操作：

- **读取 PR**：`gh pr view <number> --comments` 和 `gh pr diff <number>` 查看差异。
- **列出待分流的外部 PR**：`gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`，然后只保留 `authorAssociation` 为 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR` 或 `NONE` 的项（排除 `OWNER`/`MEMBER`/`COLLABORATOR`）。
- **评论 / 标记 / 关闭**：`gh pr comment`、`gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub 的 issue 和 PR 共享同一个编号空间，因此单独的 `#42` 可能是其中任一个——用 `gh pr view 42` 确认，失败后再用 `gh issue view 42`。

## 当技能说“发布到 issue tracker”时

创建 GitHub issue。

## 当技能说“获取相关 ticket”时

运行 `gh issue view <number> --comments`。

## 工单生命周期

任何执行方共用同一套流转，不区分 solo 会话还是被派发的 agent。标签字符串见 `triage-labels.md`。

- **认领**：动手前一条命令完成 `gh issue edit <n> --add-assignee @me --add-label "<in-progress>" --remove-label "<ready-for-agent>"`。已有 assignee 的工单视为他人已认领，不要抢。
- **交付**：PR 描述写 `Closes #<n>`，一个 PR 对应一张工单；一个 PR 收口多张时逐行写。
- **关闭**：合并时由 GitHub 自动关闭，不手动 `gh issue close`。不产生 PR 的工单（问题型、分流拒绝）由解决方评论后直接关闭。
- **放弃**：未合并就中止时回滚认领 `gh issue edit <n> --remove-assignee @me --add-label "<ready-for-agent>" --remove-label "<in-progress>"`，不把工单留在进行中。

## 发布前查重

发布新 spec 或工单前，先用 `gh issue list --state open` 找重叠，按重叠程度选一个动作：

- **完全重复**：不新建，用 `gh issue comment` 把新信息补到原票。
- **属于对方范围**：挂成对方的子 issue，或写阻塞边。
- **我们有更好的方案**：用 `gh issue edit <n> --body` 改写原票正文，并评论说明改动理由，不静默另起一张。
- **需要对方拍板**：只评论提问，不擅自动手。

## Wayfinding 操作

由 `/wayfinder` 使用。地图是一个带有子 issue 作为 ticket 的单一 issue。

- **地图**：一个标记为 `wayfinder:map` 的单一 issue，正文包含 Notes / Decisions-so-far / Fog。`gh issue create --label wayfinder:map`。
- **子 ticket**：作为 GitHub 子 issue 链接到地图的 issue（通过子 issue endpoint 使用 `gh api`）。未启用子 issue 时，在地图正文的任务列表中添加子项，并在子正文顶部写入 `Part of #<map>`。标签：`wayfinder:<type>`（`research`/`prototype`/`grilling`/`task`）。认领后，将 ticket 分配给负责的开发者。
- **阻塞**：GitHub 的**原生 issue 依赖**是规范且在 UI 中可见的表示。使用 `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>` 添加边，其中 `<blocker-db-id>` 是阻塞者的数字**数据库 id**（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`，不是 `#number` 或 `node_id`）。GitHub 报告 `issue_dependencies_summary.blocked_by`（仅开放的阻塞者——实时闸门）。不可用时，退回在子正文顶部写入 `Blocked by: #<n>, #<n>`。所有阻塞者都关闭后，ticket 才解除阻塞。
- **前沿查询**：列出地图的开放子项（`gh issue list --state open`，限定到地图的子 issue / 任务列表），排除有开放阻塞者（`issue_dependencies_summary.blocked_by > 0`，或 `Blocked by` 行中存在开放 issue）或已有受理人的项；按地图顺序取第一个。
- **认领**：按上方工单生命周期的认领命令 — 本会话的第一次写入。
- **解决**：`gh issue comment <n> --body "<answer>"`，然后 `gh issue close <n>`，最后将上下文指针（gist + link）追加到地图的 Decisions-so-far。
