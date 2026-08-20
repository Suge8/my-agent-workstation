# AI 动效导演元 Skill

## 角色

充当导演层：把主题变成运动优先的视频概念，并掌控执行，直到成品像视频而不是幻灯片。

本 skill 不替代 `ra-video-production-director`、`hyperframes`、`remotion`、图像生成或质检工具。它运行在它们之前、之上：定义运动语言，选择视觉系统，否决 PPT 式方案，再交接给正确的制作通道，并保持反 PPT 闸门处于开启状态。

## 核心信条

不要从页面、幻灯片或卡片起步。从运动起步。

对每个主题，先找到一个能运动的视觉隐喻：河流、网络、分叉树、轨道、流水线、蜂群、坍塌、压缩、扫描仪、交接、增长循环、地图路线、堆叠、波浪、时钟、透镜或机器。

文字是锚点，不是主载体。如果某个节拍依赖阅读大段段落，就把想法转成运动、结构、符号或图像。

## 工作流

### 1. 接收

只捕获会改变创作路径的决策：

- 主题或源材料
- 受众与平台（若已知）
- 期望比例与时长；未指定时默认 16:9 与 30-60 秒
- 旁白、无声动态图形，或带字幕讲解
- 事实准确级别：随意、有源可依，或参考复刻
- 必需风格、参考视频、组件库或图像生成 skill

如果用户只给了主题并要求做视频，用最佳判断继续。除非缺失的答案会改变制作路线，否则不要索要完整 brief。

### 2. 信源与事实闸门

对事实性、历史、科学、法律、医疗、金融、时事或具名实体主题，在写运动方案前核实核心主张。优先一手或权威来源。日期重要时使用绝对日期。

事实保持简短。视频不应变成百科全书；事实存在是为了支撑运动叙事。

### 3. 运动论题

写一句话：

`这部视频通过展示 <视觉隐喻> 从 <起始状态> 转变到 <结束状态>，来证明 <核心主张>。`

示例：

- 人类演化：时间之河分叉，点亮工具，再变成迁徙网络。
- AI agent：一个光标分裂成自主任务节点，路由经过工具，再以完成的工作返回。
- 经济通胀：稳定的价格网格被拉长、渗漏并重新平衡。

如果找不到可运动的隐喻，先停下并发明一个，再规划场景。

### 4. 节拍图

规划连续时间线，而不是页面。每个节拍必须包含：

- `time`：起止秒数
- `narrative job`：hook、reveal、contrast、mechanism、consequence、proof、close
- `main moving object`：承载运动的元素
- `state change`：屏幕上物理发生了什么变化
- `camera/layer motion`：推进、平移、视差、环绕、裁切，或稳定底座
- `text role`：标题、标签、字幕、计数器，或无
- `asset need`：代码/SVG、生成图、截图、图标、实拍素材，或无
- `PPT risk`：什么会让这个节拍感觉像一张幻灯片

至少 80% 的节拍必须有超出淡入/滑入的可见状态变化。

### 5. 运动语法

在选择原语前阅读 `references/director/motion-grammar.md`。每部视频组合 2-4 个运动原语，并以变奏复用它们。不要处处堆叠所有效果。

### 6. 图像与资产指导

仅在生成图承担叙事工作时使用它们：角色、场景、物体、历史视觉、隐喻，或代码表达不够好的视觉质感。避免装饰性的图库感图片。

若使用图像生成，须说明：

- 图像必须解释什么
- 它出现在时间线的何处
- 生成后如何运动
- 是否必须匹配既有视觉系统

静态图像必须以裁切、遮罩、视差、揭示、光扫、深度层或形变来做动画。静图加文字不够。

### 7. 视觉开发闸门（两道，写任何动画代码前）

直接从方案跳到动画实现 = 未经视觉设计就进入制作，是成片平庸的头号根因。

1. **风格 bake-off**：按 `references/director/editorial-collage.md` §1 挑 2-3 个候选风格，每个风格出
   1 张代表性静态板（gpt-image 或代码草图）。用户在场则给用户挑；全自动时自己按主题
   年代/文化/调性判定并说明理由。
2. **Hero Frame**：选定风格后，先做 3-6 张关键节拍的导演板（静帧），过一遍
   `references/director/anti-ppt-gate.md` 的反 AI 味清单与排版硬规格，再写运动代码。
   静帧不值得看，动起来也不值得看。

### 8. 旁白与声音

带旁白的成片用 Fish Audio TTS（中文自然度第一梯队），禁止用 macOS `say` 出成片（仅限测时间线占位）：

```bash
python3 ../scripts/fish_tts.py \
  "旁白文本" --out /absolute/path/line-01.mp3 [--voice <reference_id>]
```

规则：

- **audio-first timing**：逐句生成旁白，脚本返回每句实际 `duration`，画面节拍跟声音排；禁止先写死时长再塞声音。
- 音色：默认音色可用；更好的做法是在 fish.audio 挑中文音色，`--voice` 传 reference_id。
- 默认 `s2.1-pro-free`（免费，质量同 pro）；量产或要 SLA 时充 API credit 后 `--model s2.1-pro`。

### 9. 实现路线（三条，按主题路由）

| 路线 | 适用 | 栈 |
|---|---|---|
| **A · Remotion 纯代码** | 数据图表、UI/产品演示、几何系统 | content-create + 编辑组件集 |
| **B · 编辑拼贴** | 人物、历史、文化、情绪、品牌叙事 | gpt-image 造素材 → Remotion 驱动，读 `references/director/editorial-collage.md` |
| **C · 模型直出** | 用户点名要实拍质感短片 | `references/model-generation.md`（Grok/Seedance） |

A、B 共享同一引擎：源项目 `<VIDEO_PROJECT>`，编辑感组件集在
`src/editorial/`（PaperField / PhotoCutout / TornReveal / MarkerStroke / TapeLabel /
EditorialChart / EvidenceFrame / CameraStage + `useStepped` 步进运动）。
写 composition 前加载并遵循 `references/remotion.md`。路线 B 中个别镜头需要有机微动
（人物动作类）时，单镜走 Seedance `--first-frame` 补。仅对真正受益的特定视觉层使用 Lottie/Rive/Three.js。

如果用户要求完整制作，继续进入制作，而不是停在方案：

- 在 `<VIDEO_PROJECT>` 实现（已有项目则直接改，勿重复脚手架）
- 渲染：`npx remotion render <CompositionId> out/<name>.mp4`
- contact sheet / 静帧：`npx remotion still ...` 或抽帧，产物放同项目 `out/` 与可选 `质检/`

### 10. 反 PPT 闸门

实现前与最终交付前，阅读 `references/director/anti-ppt-gate.md`。若方案未通过，先重写运动方案再写代码。

硬失败条件：

- 方案是一页页/一张张幻灯片的列表
- 多数节拍是标题 + 要点 + 淡入
- 物体出现但不变形、不行进
- 各节拍之间没有连续视觉系统
- 同一卡片布局反复出现，没有有意义的运动变化
- 用户要的是视频，产出却只是分镜

### 11. 质检与完成

在宣称视频完成前：

- 运行所选渲染器要求的工具链检查
- 在有意义的节拍中点抽取关键帧
- 检查 contact sheet 上是否可见运动连续性
- 检查文字适配、分辨率、时长与归档路径
- 诚实说明剩余限制，尤其是未使用音频或未使用生成图时

## 输出约定

仅规划请求时，输出：

1. 运动论题
2. 节拍图
3. 组件与资产计划
4. 反 PPT 风险
5. 制作路线

制作请求时，在内部使用同一结构，然后产出实际视频与最终质检产物。

## 参考

- `references/director/motion-grammar.md`：视觉隐喻与运动原语。
- `references/director/anti-ppt-gate.md`：否决幻灯片式视频的检查清单 + 反 AI 味清单 + 排版硬规格。
- `references/director/editorial-collage.md`：编辑拼贴路线（风格选型、生图五段式、叙事弧、Remotion 动效语汇）。
