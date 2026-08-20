---
name: ui-picks
description: 个人 UI 库选型表：需要动效组件、图标动效、canvas 特效、AI 聊天界面、界面音效、字体搭配等能力时查表选库，按指定方式安装最新版本；用户说"选型库 / 我的库 / 用什么库"时也使用。
---

# UI Picks

个人品味的 UI 库选型表。命中场景就用表里的库，不另找竞品；组件清单和 API 以各库的 llms.txt / registry / 文档为准，构建时现取，不依赖本文快照。

## 使用规则

1. 按任务识别场景，不按用户提到的库名。"要个粒子背景"是特效场景，即使用户没提任何库。
2. 先查 `package.json`。项目已用表内库直接用；已用竞品（如别的 chat UI 库）时提示本表推荐，但不擅自换依赖。
3. 每个场景只推荐一个库，说明用途一句话，属于请求范围就直接安装接线。
4. 特效层不得牺牲内容层：文字保持可选中、链接可点击、核心信息不依赖特效呈现。
5. 装饰性动效不限场景：落地页、portfolio 之外，webapp、产品 UI 也可按需用，好看且服务体验即可；落地后按 ui-craft 检查 AI 模板痕迹、性能和 reduced-motion。

## 选型表

### Amicro — 卡片编排微交互（React）

- Cover-flow、扇形展开、arc、time-machine 等卡片空间编排和微转场；站点 [amicro.vercel.app](https://amicro.vercel.app)。
- 获取：从站点组件页直接复制源码进项目（依赖 Motion）。官方 `npx @subhanhq/amicro@latest add` 实测不可用（npm 包无可执行入口，2026-08 验证），修复前不要用。
- 无 llms.txt，文档是纯客户端渲染，选组件靠站点浏览。
- 落地后按 ui-craft 的弹簧与空间连续性纪律收口（同一几何关系派生、可中断、reduced-motion）。

### OriginKit — 文字动效 / 光标特效 / 图片画廊 / 背景动画（React / Framer）

- 约 160 个免费动效组件：文字特效、光标特效、图片画廊、背景动画和 hero/features 等营销 sections；站点 [originkit.dev](https://www.originkit.dev)。
- 获取：`npx originkit@latest add <compid>`（shadcn 式源码分发，落进 `components/originkit/`，deps 自动装，`add` 消耗账号 quota）；机读靠 MCP `https://mcp.originkit.dev/mcp`（list_components / get_component / search / fetch，可按 react/nextjs/vite 适配源码），无 llms.txt 和 registry.json。
- 红线：产品处于 BETA；组件按 Framer 优先编写，React 侧落地后检查 Framer 绑定剥离干净（`"use client"`、no-op shim 无残留）。
- 分工：Amicro 管卡片空间编排，Canvas UI 管 WebGL 覆盖交互 DOM，Paper Shaders 管纯背景纹理；文字/光标/画廊类动效归这里。

### Fluid Functionalism — 成品感产品 UI 组件（React / shadcn registry）

- 23 个产品 UI 组件（Button、Dialog、Select、Tabs、Table 等）含 AI 聊天视觉件（ChatMessage、ThinkingIndicator、ThinkingSteps、AskUserQuestions）；设计理念是动效传达语义、hover 即预览，与 ui-craft 门禁契合。
- 获取：`npx shadcn@latest add https://www.fluidfunctionalism.com/r/<组件>.json`（源码复制分发）；机读清单读 <https://www.fluidfunctionalism.com/r/registry.json>（53 项，含 hooks 与 surface/spring token），不要用 `/r/base/` 路径（仅部分组件存在）。系统文档在 [fluidfunctionalism.com/docs](https://www.fluidfunctionalism.com/docs)，无 llms.txt。
- 与 assistant-ui 分工：这里是纯视觉组件；需要线程、流式、工具调用等完整 chat runtime 时用 assistant-ui，两者可搭配。

### Beautiful UI — AI-native 产品界面原语（React / TypeScript）

- 19 个高完成度交互原语，覆盖思考态、流式回答、人工审批、工具调用、聊天、数据表和 AI 编辑器；站点 [beautiful-ui-five.vercel.app](https://beautiful-ui-five.vercel.app/)。
- 获取：每个示例右上角直接 Copy code 或 View code；无 llms.txt、registry 和 CLI，只能按站内组件目录人工选取。源码会引用站点 CSS token、共享 atoms，部分组件另需 `glimm`、`liveline` 或 `iconoir-react`，落地时按实际 import 补齐并接入项目设计系统。
- 授权：MIT（站点 /license 页，2026-08 验证），商用可复制。红线：示例里的 mock 数据、定时状态流和主题类名不是生产实现，必须换成真实业务状态并补 reduced-motion。
- 分工：这里只取 AI 交互的视觉与状态表达；线程、流式传输、工具协议等 chat runtime 仍用 assistant-ui，通用产品控件用 Fluid Functionalism。

### Canvas UI — WebGL / shader 特效叠在可交互的真实 DOM 上

- 流体、火焰、玻璃、Shatter、VHS 等效果覆盖实时界面；站点 [canvasui.dev](https://canvasui.dev)，清单读 <https://canvasui.dev/llms.txt>。
- 获取：`npx shadcn@latest add @canvas-ui/<组件>-react`（`react` 可换 `solid`/`vue`/`svelte`/`vanilla`）；也可把 shadcn MCP 指向该 registry。这是源码复制分发：组件落进 `components/canvasui/` 自由改，不把库装成依赖。
- 红线：完整效果依赖实验性 html-in-canvas API（Chrome/Edge 140+ 且开 flag），其余浏览器降级为 WebGL overlay。上线前必须实测降级表现；移动端验证功耗与帧率。

### Paper Shaders — 轻量 shader 背景/纹理（mesh gradient、噪声、dot 等）

- 零依赖 canvas shader 组件，做背景纹理或按形状/文字遮罩；站点 [shaders.paper.design](https://shaders.paper.design)，组件与参数以该文档为准。
- 安装：React `npm i @paper-design/shaders-react`；其他框架（Svelte/Vue/Solid 等）用零依赖核心包 `npm i @paper-design/shaders`，在挂载钩子里用 `ShaderMount` 对着容器元素初始化。官方 0.0.x 下会发 breaking change，必须 pin 精确版本。
- 与 Canvas UI 分工：Paper Shaders 是纯背景/纹理层不承载交互；要 WebGL 效果覆盖可交互 DOM 才用 Canvas UI。

### morphicons — SVG 图标 morph 动效（React / Vue / Svelte / RN / vanilla）

- 任意 stroke 图标平滑变形到另一个（menu→X、play→pause 等），可中断弹簧物理，零配置零依赖 ~6-8KB；站点 [morphicons.com](https://www.morphicons.com)，机读 <https://www.morphicons.com/llms.txt>（完整 API 在 llms-full.txt）。
- 安装：`npm i morphicons`，按框架取 `morphicons/react|vue|svelte|react-native|dom` 入口；图标以数据形式导入（装 `lucide` 包，不是 `lucide-react` 组件）。SSR 干净、默认 `aria-hidden`、自动尊重 reduced-motion。
- 红线：只支持 stroke 图标（Lucide/Tabler/Heroicons outline/Iconoir 等）；非 24×24 网格的包先用 `fitIcon` 重排一次。

### assistant-ui — 产品内 AI 聊天界面（React/TS）

- 线程、流式输出、Markdown、工具调用 UI 等 ChatGPT 级交互；站点 [assistant-ui.com](https://www.assistant-ui.com)，文档读 <https://www.assistant-ui.com/llms.txt>。
- 安装：已有项目 `npx assistant-ui@latest init`，新项目 `npx assistant-ui@latest create`；或直接装 `@assistant-ui/react` + 对应 runtime 包（如 `@assistant-ui/react-ai-sdk`）。
- 属于产品 UI：样式与密度对齐项目设计系统，不套库默认主题了事。

### UI SFX — 语义化界面音效（Web Audio / 跨端音频文件）

- 78 个语义 cue（success、drop、processing、level-up 等）× 12 套音色人格，按交互语义调用、换 pack 不改交互代码；站点 [uisfx.com](https://uisfx.com)，机读读 <https://uisfx.com/docs/agent-guide.md>（另有可直接复制的接线提示词 `/agent-prompt.txt`）。
- 安装 `npm i uisfx`：`createUISFX({ pack, preferences: {} })` + 首次可信交互里 `await ui.unlock()`（绕开自动播放限制），运行时 12KB 零依赖、本地合成不拉音频；React Native / 原生 / 引擎侧改用包内 `uisfx/sounds/{pack}/{cue}.mp3|ogg` 与 `uisfx/manifest`。代码 MIT、音频 CC0。
- 红线：音效只强化已有的可见反馈，成功/警告/错误必须各自有视觉区分；提供持久静音开关（`setEnabled`），loop cue 随可见状态结束即 `stop()`，密集界面里 hover 音保持安静或关闭。

### 字体来源 — Fontshare（拉丁）+ 中文免费梯队（CJK）

- 拉丁标题/正文选型用 [fontshare.com](https://www.fontshare.com)：ITF 出品免费商用（Satoshi、General Sans、Clash Display 等），质量对标付费字体；接入走官方 API `<link>` 或下载 offline kit。
- 红线：Closed Source 字体按 ITF FFL —— 禁改字体文件、禁再分发（含传给外包设计师）；全库无 CJK，中文界面只能做英文/数字层，必须配中文回退字体栈。
- 中文选型直接用质量梯队：UI 正文选 MiSans / 阿里巴巴普惠体 3.0 / HarmonyOS Sans（大厂定制体，免费池屏显天花板）；标题出彩用得意黑（OFL，官方明确不适合正文和手机界面）；文艺/阅读用霞鹜文楷、思源宋体。新字体筛选看[猫啃网](https://www.maoken.com)；要 Fontshare 级惊艳只能走商业授权（字由/方正）。
- 中文 webfont 必须分包（单文件 10-20MB）：自托管用 [中文网字计划](https://chinese-font.netlify.app/zh-cn/)的 `cn-font-split` 切包，或其字图 CDN（域名迁移中以官网为准）；它只当分包工具用，不当字体库逛——它的池子不做质量筛选。

## 加新库

每个库三到五行：名称 + 场景一句话、获取方式（llms.txt / registry / CLI）、边界与红线。只收自己真用过且认可的库，不收备选清单。
