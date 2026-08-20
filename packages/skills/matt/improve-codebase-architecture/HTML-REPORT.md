# HTML 报告格式

架构评审会在操作系统临时目录中渲染为一个自包含的 HTML 文件。Tailwind 和 Mermaid 都来自 CDN。Mermaid 能可靠处理图形结构的图表；手工构建的 div 和内联 SVG 则处理更偏编辑性的视觉内容（质量图、剖面图）。两者结合使用——不要所有内容都依赖 Mermaid，否则很快会显得千篇一律。

## 脚手架

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Architecture review — {{repo name}}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script type="module">
      import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
      mermaid.initialize({ startOnLoad: true, theme: "neutral", securityLevel: "loose" });
    </script>
    <style>
      /* small custom layer for things Tailwind doesn't cover cleanly:
         dashed seam lines, hand-drawn-feeling arrow heads, etc. */
      .seam { stroke-dasharray: 4 4; }
      .leak { stroke: #dc2626; }
      .deep { background: linear-gradient(135deg, #0f172a, #1e293b); }
    </style>
  </head>
  <body class="bg-stone-50 text-slate-900 font-sans">
    <main class="max-w-5xl mx-auto px-6 py-12 space-y-12">
      <header>...</header>
      <section id="candidates" class="space-y-10">...</section>
      <section id="top-recommendation">...</section>
    </main>
  </body>
</html>
```

## 标题区

仓库名称、日期和简洁图例：实线框 = module，虚线 = seam，红色箭头 = 泄漏，粗深色框 = deep module。不要写介绍段落——直接进入候选项。

## 候选卡片

图表承担主要信息。正文要稀少、直白，并使用 `/codebase-design` skill 中的术语表术语，不要刻意解释。

每个候选项都是一个 `<article>`：

- **标题**——简短，说明 deepening（例如“合并 Order intake pipeline”）。
- **徽章行**——推荐强度（`Strong` = emerald，`Worth exploring` = amber，`Speculative` = slate），以及依赖类别标签（`in-process`、`local-substitutable`、`ports & adapters`、`mock`）。
- **文件**——等宽字体列表，使用 `font-mono text-sm`。
- **Before / After 图表**——核心内容。两列并排。参见下面的模式。
- **问题**——一句话。哪里造成了痛点。
- **解决方案**——一句话。发生什么变化。
- **收益**——项目符号，每项不超过 6 个词。例如：“测试命中一个 interface”“Pricing 逻辑不再泄漏”“删除 4 个浅层 wrapper”。
- **ADR 提示**（如适用）——琥珀色背景框中的一行文字。

不要写解释段落。如果图表需要段落才能看懂，就重画图表。

## 图表模式

选择适合候选项的模式。混合使用。不要让每张图表看起来都一样——多样性本身就是重点。

### Mermaid 图（依赖关系 / 调用流程的主力）

当重点是“X 调用 Y，Y 调用 Z，看看这团乱麻”时，使用 Mermaid `flowchart` 或 `graph`。用 Tailwind 样式的卡片包裹它，避免显得突兀。使用 classDef 将泄漏边标红，将 deep module 设为深色。对于“before：6 次往返；after：1 次”的场景，时序图效果很好。

```html
<div class="rounded-lg border border-slate-200 bg-white p-4">
  <pre class="mermaid">
    flowchart LR
      A[OrderHandler] --> B[OrderValidator]
      B --> C[OrderRepo]
      C -.leak.-> D[PricingClient]
      classDef leak stroke:#dc2626,stroke-width:2px;
      class C,D leak
  </pre>
</div>
```

### 手工构建的框和箭头（Mermaid 布局不理想时）

用带边框和标签的 `<div>` 表示 modules。箭头使用内联 SVG 的 `<line>` 或 `<path>` 元素，绝对定位在相对定位的容器上方。当你希望“after”图表呈现为一个带粗边框的 deep module、内部内容变灰时，使用此模式——Mermaid 无法以合适的视觉权重渲染它。

### 剖面图（适合分层的浅层结构）

堆叠水平带（`h-12 border-l-4`）来表示调用经过的层。Before：6 个什么都不做的薄层。After：1 个标注合并后职责的厚带。

### 质量图（适合“interface 和 implementation 一样宽”）

每个 module 使用两个矩形——一个表示 interface 的表面积，一个表示 implementation。Before：interface 矩形几乎和 implementation 矩形一样高（shallow）。After：interface 矩形较矮，implementation 矩形较高（deep）。

### 调用图合并

Before：以嵌套框渲染的函数调用树。After：将同一棵树合并成一个框，现已内部化的调用以淡化效果显示在其中。

## 样式指南

- 偏编辑性，不要像企业仪表盘。留出充足空白。标题可选用衬线字体（`font-serif` 与 stone/slate 搭配效果很好）。
- 少量用色：一个强调色（emerald 或 indigo），另用红色表示泄漏、琥珀色表示警告。
- 图表高度保持约 320px，让 before/after 并排显示时无需滚动。
- 图表内的 module 标签使用 `text-xs uppercase tracking-wider`——它们应当像示意图，而不是 UI。
- 只使用 Tailwind CDN 脚本和 Mermaid ESM import。报告其余部分应是静态内容——没有应用代码，除了 Mermaid 自身的渲染外不具备交互性。

## 顶部推荐区

一个更大的卡片。候选项名称、一句话说明原因、指向其卡片的锚点链接。仅此而已。

## 语气

简洁直白的中文，但架构名词和动词直接来自 `/codebase-design` skill。简洁不能成为偏离术语的借口。

**只使用：** module、interface、implementation、depth、deep、shallow、seam、adapter、leverage、locality。

**绝不替换为：** component、service、unit（当指 module 时）· API、signature（当指 interface 时）· boundary（当指 seam 时）· layer、wrapper（当你实际指 module 时）。

**符合此风格的表述：**

- “Order intake module 很 shallow——interface 几乎等同于 implementation。”
- “Pricing 跨 seam 泄漏。”
- “Deepen：一个 interface，一个测试位置。”
- “两个 adapter 足以证明 seam 存在：生产环境用 HTTP，测试用内存实现。”

**Wins 项目符号**要用术语表中的术语命名收益：*“locality：bug 集中在一个 module 中”*、*“leverage：一个 interface，N 个调用点”*、*“interface 收缩；implementation 吸收 wrappers”*。不要写 *“更易维护”* 或 *“代码更干净”*——这些术语不在术语表中，不值得占据位置。

不要模棱两可，不要铺垫，不要写“值得注意的是……”。如果一句话可以成为项目符号，就把它写成项目符号。如果一个项目符号可以删掉，就删掉。如果某个术语不在 `/codebase-design` 术语表中，优先使用其中的术语，而不是创造新术语。
