---
name: project-setup
disable-model-invocation: true
description: 项目骨架与文档一致性体检：初始化、半途补缺、开源前检查或“这个项目缺什么”。只盘点并路由缺口；UI 设计用 ui-craft，发布用 ship，不负责开发功能。
---

# Project Setup（项目体检）

清单 + 路由器，**自己不生产内容**。一致性的来源是：每个项目同一套文档骨架，文档是事实源，内容由专业 skill 生产，日常开发的 agent 读文档而不是重新发明。本 skill 只保证骨架存在、缺口被看见、活派给对的 skill。

## Step 1 — 探索（只读，不动任何文件）

- 技术栈与任务运行器（package.json / Cargo.toml / justfile）
- 有无 UI（前端框架、src-tauri、routes 目录等信号）
- 开源信号（LICENSE 存在？git remote 是公开仓库？用户说过要开源？）
- 现有文档盘点：AGENTS.md、CONTEXT.md、README、CONTRIBUTING、SECURITY、CHANGELOG、docs/adr/，以及已有的 PRD、roadmap、DESIGN.md
- 验证链现状：有没有 Agent 可独立运行的验证入口、通过价值门的行为测试，以及已配置但未接入的 formatter/lint/typecheck（对照 set-test-chain 的 references/toolchains.md 判断）

## Step 2 — 体检表

按下面清单输出一张表：`✓ 已有 / ✗ 缺 / — 不适用`，缺的附一行推荐动作。

**所有项目必备**

| 文档       | 作用                                                       | 位置   |
| ---------- | ---------------------------------------------------------- | ------ |
| AGENTS.md  | agent 导览图：一句话定位、目录导览、常用命令、指向其余文档 | 根目录 |
| CONTEXT.md | 领域词汇表：项目里每个词的准确含义                         | 根目录 |

产品方向沿用项目已有的 README、PRD 或 roadmap，不为统一骨架新建设计文档。已有 `DESIGN.md` 时检查它是否仍与代码一致；缺少不是体检问题。

**要开源才要**：LICENSE（根，GitHub 侧栏识别要求）、用户向 README（根）、CONTRIBUTING.md 和 SECURITY.md（放 `.github/`：GitHub 功能照常生效，根目录保持干净；三个合法位置 根/.github/docs 中的最优解）。

**位置总原则**：高频入口（README/LICENSE/CHANGELOG/AGENTS/CONTEXT）在根；低频社区件在 `.github/`；深度内容（PRD、DESIGN、adr 和开发文档）在 `docs/`。已存在于其他合法位置的不迁移——位置不是问题，双份才是。

**体检项（只报告，绝不动手）**：验证链是否达到 set-test-chain 的“首次建链”标准。不达标就在表里写一行现状 + 推荐动作，让用户拿去找 set-test-chain 建；不因缺少可选静态工具直接推荐安装。

## Step 3 — 分节确认

一节一个问题，**每节先给推荐答案**，让用户一个词就能接受。已有的文档不重写——只在内容与现状明显脱节时报告差距。同一事实不得存两份（发现新旧两份时提议合并，保留 docs/ 下的那份）。

## Step 4 — 派活

| 缺口                    | 派给                                                              | 说明                                                                |
| ----------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------- |
| CONTEXT.md              | Matt `domain-modeling`                                            | 从代码提取候选术语，确认后按其格式写入；在 AGENTS.md 中标注为活文档 |
| AGENTS.md               | 本 skill 直接写                                                   | 内容全部来自 Step 1 的探索事实，不编造                              |
| README                  | 本 skill 按项目事实起草；营销文案用 copywriting，成稿用 stop-slop | 语言规则见下                                                        |
| CONTRIBUTING / SECURITY | 本 skill 起草，文案走 stop-slop                                   | 语言规则见下                                                        |

## 语言规则

- 内部文档（AGENTS.md、CONTEXT.md、docs/ 全部）：**中文**
- 社区文件（CONTRIBUTING.md、SECURITY.md）：**英文**——受众是全球贡献者
- README：跟随项目目标用户与既有约定；多语言版本使用独立文件，并在顶部互相链接
- CHANGELOG：跟随仓库现有格式（ship skill 负责维护）
