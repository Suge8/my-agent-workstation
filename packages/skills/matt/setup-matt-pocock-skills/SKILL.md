---
name: setup-matt-pocock-skills
description: 为本仓库配置工程技能——设置其 issue tracker、分流标签词汇和领域文档布局。在首次使用其他工程技能前运行一次。
disable-model-invocation: true
---

# 设置 Matt Pocock 的技能

搭建工程技能所依赖的每仓库配置：

- **Issue tracker** — issue 所在的位置（默认是 GitHub；同时开箱即用地支持本地 markdown）
- **标签词汇** — 分流、类型和生命周期角色所使用的字符串
- **领域文档** — `CONTEXT.md` 和 ADR 的位置，以及读取它们的使用方规则

这是一个由提示驱动的技能，不是确定性脚本。先探索，展示发现的内容，向用户确认，然后写入。

## 流程

### 1. 探索

查看当前仓库，了解其初始状态。读取所有现有内容；不要假设：

- `git remote -v` 和 `.git/config` — 这是 GitHub 仓库吗？是哪一个？
- 仓库根目录的 `AGENTS.md` 和 `CLAUDE.md` — 哪个存在？其中是否已有 `## Agent skills` 部分？
- 仓库根目录的 `CONTEXT.md` 和 `CONTEXT-MAP.md`
- `docs/adr/` 以及任何 `src/*/docs/adr/` 目录
- `docs/agents/` — 这个技能之前的输出是否已经存在？
- `.scratch/` — 是否表明已经在使用本地 markdown issue tracker 约定？
- Monorepo 信号 — `pnpm-workspace.yaml`、`package.json` 中的 `workspaces` 字段，或有自身 `src/` 的非空 `packages/*`。只有真正大型的多包仓库才会出现；没有这些信号就表示单一上下文，这几乎适用于所有仓库。

### 2. 展示发现并询问

总结已有和缺少的内容。然后按顺序处理各部分——一次一部分，回答后再进入下一部分。

每部分先给出推荐答案，让用户可以用一个词接受。仅在选择确实分叉时提供一行解释；如果探索已经确定选择，则完全跳过该部分（没有 monorepo 时跳过 C）。

**A 部分——Issue tracker。**

> 解释：“issue tracker”是本仓库 issue 所在的位置。`to-tickets`、`triage` 和 `to-spec` 等技能会从中读取并写入——它们需要知道应该调用 `gh issue create`、在 `.scratch/` 下写入 markdown 文件，还是遵循你描述的其他工作流。选择本仓库实际跟踪工作的地方。

默认倾向：这些技能是为 GitHub 设计的。如果 `git remote` 指向 GitHub，就提议 GitHub；如果指向 GitLab（`gitlab.com` 或自托管主机），就提议 GitLab。否则（或用户偏好其他选项），提供：

- **GitHub** — issue 位于仓库的 GitHub Issues 中（使用 `gh` CLI）
- **GitLab** — issue 位于仓库的 GitLab Issues 中（使用 [`glab`](https://gitlab.com/gitlab-org/cli) CLI）
- **本地 markdown** — issue 作为文件位于本仓库的 `.scratch/<feature>/` 下（适合个人项目或没有远程仓库的仓库）
- **其他**（Jira、Linear 等）— 请用户用一段话描述工作流；技能会将其记录为自由文本

将选择记录到 `docs/agents/issue-tracker.md`。GitHub 和 GitLab 模板带有“PR 作为请求入口”标志，默认设为 **off** — 保持关闭，不要主动提出；希望将外部 PR 放入 triage 队列的用户之后可以在文件中切换该标志。

**B 部分——标签词汇。** 无条件运行：分流标签供 `triage` 使用，类型标签供建票技能使用，生命周期标签供每个领工单的执行方使用——后两类与 `triage` 是否安装无关。

只问一个问题：

> 是否保留默认标签词汇？（推荐：**是**）

默认值是每个标签字符串都等于其角色名：分流的 `needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`，类型的 `spec`，生命周期的 `in-progress`、`blocked`。如果回答 **是**，原样写入。只有用户回答否时——通常因为其 tracker 已使用其他名称（例如用 `bug:triage` 表示 `needs-triage`）——才收集覆盖值，让技能使用现有标签而不是创建重复标签。

**C 部分——领域文档。** 默认使用**单一上下文**——仓库根目录下一个 `CONTEXT.md` 和 `docs/adr/`。这适合几乎所有仓库；直接写入，不询问。

只有在探索发现 monorepo 信号时，才提供**多上下文**——根目录的 `CONTEXT-MAP.md` 指向各上下文的 `CONTEXT.md` 文件。然后确认用户想要哪种布局。

### 3. 确认并编辑

向用户展示以下内容的草稿：

- 要添加到正在编辑的 `CLAUDE.md` / `AGENTS.md` 中的 `## Agent skills` 块（选择规则见第 4 步）
- `docs/agents/issue-tracker.md`、`docs/agents/triage-labels.md` 和 `docs/agents/domain.md` 的内容

写入前允许用户编辑。

### 4. 写入

**选择要编辑的文件：**

- 如果 `CLAUDE.md` 存在，编辑它。
- 否则如果 `AGENTS.md` 存在，编辑它。
- 如果两者都不存在，询问用户要创建哪一个——不要替用户选择。

如果 `CLAUDE.md` 已存在，绝不要创建 `AGENTS.md`（反之亦然）——始终编辑已经存在的那个。

如果所选文件中已有 `## Agent skills` 块，就在原处更新其内容，而不是追加重复块。不要覆盖周围部分中的用户编辑内容。

该块：

```markdown
## Agent skills

### Issue tracker

[issue 跟踪位置的一行摘要]。参见 `docs/agents/issue-tracker.md`。

### Labels

[标签词汇的一行摘要]。参见 `docs/agents/triage-labels.md`。

### Domain docs

[布局的一行摘要——“single-context”或“multi-context”]。参见 `docs/agents/domain.md`。
```

然后使用本技能目录中的种子模板作为起点写入文档文件：

- [issue-tracker-github.md](./issue-tracker-github.md) — GitHub issue tracker
- [issue-tracker-gitlab.md](./issue-tracker-gitlab.md) — GitLab issue tracker
- [issue-tracker-local.md](./issue-tracker-local.md) — 本地 markdown issue tracker
- [triage-labels.md](./triage-labels.md) — 标签映射
- [domain.md](./domain.md) — 领域文档使用方规则 + 布局

对于“其他” issue tracker，根据用户的描述从头写入 `docs/agents/issue-tracker.md`。

### 5. 完成

告诉用户设置已完成，以及哪些工程技能现在会从这些文件读取。说明用户之后可以直接编辑 `docs/agents/*.md`；只有希望切换 issue tracker 或从头重新开始时，才需要再次运行此技能。
