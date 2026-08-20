# Issue tracker：GitLab

本仓库的 issue 和规格说明位于 GitLab issue 中。所有操作都使用 [`glab`](https://gitlab.com/gitlab-org/cli) CLI。

## 约定

- **创建 issue**：`glab issue create --title "..." --description "..."`。多行描述使用 heredoc。传入 `--description -` 打开编辑器。
- **读取 issue**：`glab issue view <number> --comments`。使用 `-F json` 获取机器可读输出。
- **列出 issue**：`glab issue list -F json`，配合适当的 `--label` 过滤器。
- **评论 issue**：`glab issue note <number> --message "..."`。GitLab 将评论称为“notes”。
- **应用 / 移除标签**：`glab issue update <number> --label "..."` / `--unlabel "..."`。多个标签可以逗号分隔，或重复传入该标志。
- **关闭**：`glab issue close <number>`。`glab issue close` 不接受关闭评论，因此先用 `glab issue note <number> --message "..."` 发布说明，再关闭。
- **合并请求**：GitLab 将 PR 称为“merge requests”。使用 `glab mr create`、`glab mr view`、`glab mr note` 等——形式与 `gh pr ...` 相同，只是将 `pr` 换成 `mr`，将 `comment`/`--body` 换成 `note`/`--message`。

从 `git remote -v` 推断仓库；在 clone 内运行时 `glab` 会自动完成此事。

## 将合并请求作为分流入口

**MR 作为请求入口：否。**（如果本仓库将外部 merge request 视为功能请求，则设为 `yes`；`/triage` 会读取此标志。）

设为 `yes` 时，MR 使用与 issue 相同的标签和状态，通过对应的 `glab mr` 命令操作：

- **读取 MR**：`glab mr view <number> --comments` 和 `glab mr diff <number>` 查看差异。
- **列出待分流的外部 MR**：`glab mr list -F json`，然后只保留作者不是项目成员/所有者的 MR（贡献者的 MR，而非维护者正在进行的工作）。
- **评论 / 标记 / 关闭**：`glab mr note`、`glab mr update --label`/`--unlabel`、`glab mr close`。

与 GitHub 不同，GitLab 分别为 issue 和 MR 编号；知道维护者指的是哪个入口后，`#42` 不会产生歧义。

## 当技能说“发布到 issue tracker”时

创建 GitLab issue。

## 当技能说“获取相关 ticket”时

运行 `glab issue view <number> --comments`。

## 工单生命周期

任何执行方共用同一套流转，不区分 solo 会话还是被派发的 agent。标签字符串见 `triage-labels.md`。

- **认领**：动手前一条命令完成 `glab issue update <n> --assignee @me --label "<in-progress>" --unlabel "<ready-for-agent>"`。已有受理人的工单视为他人已认领，不要抢。
- **交付**：MR 描述写 `Closes #<n>`，一个 MR 对应一张工单；一个 MR 收口多张时逐行写。
- **关闭**：合并时由 GitLab 自动关闭，不手动 `glab issue close`。不产生 MR 的工单（问题型、分流拒绝）由解决方发 note 后直接关闭。
- **放弃**：未合并就中止时回滚认领（`--unassign`、标签换回 `<ready-for-agent>`），不把工单留在进行中。

## 发布前查重

发布新 spec 或工单前，先用 `glab issue list` 找重叠，按重叠程度选一个动作：

- **完全重复**：不新建，用 `glab issue note` 把新信息补到原票。
- **属于对方范围**：挂到对方的 epic，或用 `/blocked_by` 写阻塞边。
- **我们有更好的方案**：用 `glab issue update <n> --description` 改写原票正文，并发 note 说明改动理由，不静默另起一张。
- **需要对方拍板**：只发 note 提问，不擅自动手。

## Wayfinding 操作

由 `/wayfinder` 使用。地图是一个带有子 issue 作为 ticket 的单一 issue。

- **地图**：一个标记为 `wayfinder:map` 的单一 issue，正文包含 Notes / Decisions-so-far / Fog。`glab issue create --label wayfinder:map`。（在支持原生 epic 的 GitLab 层级中，也可以由 epic 承载地图；带标签的 issue 在所有地方都可用。）
- **子 ticket**：在描述顶部写有 `Part of #<map>`、并带有 `wayfinder:<type>`（`research`/`prototype`/`grilling`/`task`）标签的 issue。认领后，将 ticket 分配给负责的开发者。
- **阻塞**：GitLab 的**原生 blocking link** 是规范且在 UI 中可见的表示。使用作为 note 发布的 `/blocked_by #<n>` quick action 添加（`glab issue note <child> --message "/blocked_by #<blocker>"`）。原生阻塞链接是 Premium/Ultimate 功能；在免费层级（或不可用时）退回在描述顶部写入 `Blocked by: #<n>, #<n>`。所有阻塞者都关闭后，ticket 才解除阻塞。
- **前沿查询**：使用 `glab issue list -F json` 限定到地图的子项，排除有开放阻塞者——指向开放 issue 的原生 `blocked_by` 链接（`glab api projects/:id/issues/:iid/links`），或 `Blocked by` 行中的开放 issue——或已有受理人的项；按地图顺序取第一个。
- **认领**：按上方工单生命周期的认领命令 — 本会话的第一次写入。
- **解决**：`glab issue note <n> --message "<answer>"`，然后 `glab issue close <n>`，最后将上下文指针（gist + link）追加到地图的 Decisions-so-far。
