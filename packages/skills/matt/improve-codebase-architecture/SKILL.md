---
name: improve-codebase-architecture
description: 扫描代码库中的 deepening 机会，以可视化 HTML 报告呈现，然后围绕你选定的机会进行追问。
disable-model-invocation: true
---

# 改进代码库架构

发现架构摩擦并提出 **deepening 机会**——将浅层 module 转变为 deep module 的重构。目标是提升可测试性和 AI 导航能力。

此命令受项目领域模型启发，并建立在共享设计词汇之上：

- 使用 `codebase-design` skill 获取架构词汇（**module**、**interface**、**depth**、**seam**、**adapter**、**leverage**、**locality**）及其原则（删除测试、“interface 是测试面”、“一个 adapter = 假设中的 seam，两个 = 真实的 seam”）。每条建议都必须准确使用这些术语——不要偏离为“component”“service”“API”或“boundary”。
- `CONTEXT.md` 中的领域语言为良好 seam 命名；`docs/adr/` 中的 ADR 记录本命令不应重新争论的决策。

## 流程

### 1. 探索

**扫描前确定范围——YAGNI。** Deepening module 能让未来对其进行的变更更容易，因此应特别关注代码库中最近变动的部分。先决定去哪里看，再开始查看：

- 如果用户指定了方向——某个 module、子系统或痛点——就按该方向进行，跳过下面的推断。
- 否则，沿着较长一段提交历史回溯（`git log --oneline`），找出代码库的热点——反复出现的文件和区域——并优先关注这些路径。如果变更分散、没有明确热点，就扩大范围。

先阅读项目领域术语表（`CONTEXT.md`）以及你所处理区域中的所有 ADR。

然后启动一个子代理遍历代码库。不要遵循僵化的启发式规则——自然探索，并记录你遇到摩擦的地方：

- 理解一个概念是否需要在许多小 module 之间来回跳转？
- 哪些 module **shallow**——interface 几乎和 implementation 一样复杂？
- 是否有纯函数只是为了可测试性而被提取出来，但真正的 bug 藏在调用方式中（缺乏 **locality**）？
- 紧密耦合的 module 是否跨 seam 泄漏？
- 哪些代码区域没有测试，或者难以通过当前 interface 进行测试？

对任何你怀疑 shallow 的对象应用**删除测试**：删除它会让复杂性集中起来，还是只是把复杂性转移到别处？“会集中”的答案正是你要找的信号。

### 2. 以 HTML 报告呈现候选项

将自包含的 HTML 文件写入操作系统临时目录，避免任何内容进入代码库。通过 `$TMPDIR` 确定临时目录，回退到 `/tmp`（Windows 上为 `%TEMP%`），并写入 `<tmpdir>/architecture-review-<timestamp>.html`，使每次运行都生成新文件。为用户打开它——Linux 使用 `xdg-open <path>`，macOS 使用 `open <path>`，Windows 使用 `start <path>`——并告知用户绝对路径。

报告使用 **Tailwind via CDN** 负责布局和样式，并在图、流程或时序能可靠传达结构时使用 **Mermaid via CDN** 绘图。将 Mermaid 与手工制作的 CSS/SVG 视觉内容结合使用——关系呈图形结构时使用 Mermaid（调用图、依赖关系、时序），想要更偏编辑性的效果（质量图、剖面图、合并动画）时使用手工构建的 div/SVG。每个候选项都要有 **before/after 可视化**。重视视觉呈现。

为每个候选项渲染一张卡片，包含：

- **文件**——涉及哪些文件/module
- **问题**——当前架构为何造成摩擦
- **解决方案**——将发生什么变化的直白描述
- **收益**——从 locality 和 leverage 角度说明，以及测试将如何改善
- **Before / After 图表**——并排、定制绘制，展示浅层结构和 deepening
- **推荐强度**——三者之一：`Strong`、`Worth exploring`、`Speculative`，渲染为徽章

报告末尾以 **Top recommendation** 区块结束：最先处理哪个候选项，以及原因。

**使用 CONTEXT.md 的词汇描述领域，使用 `codebase-design` 的词汇描述架构。** 如果 `CONTEXT.md` 定义了“Order”，就写“Order intake module”，不要写“FooBarHandler”，也不要写“Order service”。

**ADR 冲突：** 如果候选项与现有 ADR 矛盾，只有在摩擦真实到值得重新审视该 ADR 时才展示它。在卡片中明确标记（例如警告提示：_“与 ADR-0007 矛盾——但值得重新开启，因为……”_）。不要列出 ADR 禁止的每个理论性重构。

完整的 HTML 脚手架、图表模式和样式指南参见 [HTML-REPORT.md](HTML-REPORT.md)。

暂时**不要**提出 interface。文件写入后，询问用户：“你想探索其中哪一个？”

### 3. 追问循环

用户选择候选项后，使用 `grilling` skill，与用户一起沿决策树推进——约束、依赖、deepened module 的形态、seam 后方的内容，以及哪些测试保留。

随着决策逐渐明确，副作用要内联发生——使用 `domain-modeling` skill，持续更新领域模型：

- **是否用 `CONTEXT.md` 中没有的概念为 deepened module 命名？** 将该术语加入 `CONTEXT.md`。如果文件不存在，按需创建。
- **是否在对话中明确了某个模糊术语？** 当场更新 `CONTEXT.md`。
- **用户是否因一个具有决定性作用的理由拒绝候选项？** 提供 ADR，但措辞应为：“要我把它记录为 ADR，避免未来的架构评审再次建议同一方案吗？”只有当该理由确实能帮助未来的探索者避免重复建议时才提供；短暂理由（“现在不值得”）和不言自明的理由则跳过。
- **是否想探索 deepened module 的替代 interface？** 使用 `codebase-design` skill，并使用其 design-it-twice 并行子代理模式。
