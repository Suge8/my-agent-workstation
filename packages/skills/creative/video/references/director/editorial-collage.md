# 编辑拼贴路线（Vox 式）

人物、历史、文化、情绪类主题的默认视觉系统。素材由 gpt-image 生成，动效全部由 Remotion
驱动（当前视频项目 `src/editorial/` 组件集）——不经过 AI 视频模型，
文字永远清晰、可重渲染、成本趋近于零。个别镜头需要有机微动（人物做动作、动物动）时，
才按 `references/model-generation.md` 单独用 Seedance `--first-frame` 补那一镜。

创作引擎提炼自 vox-director（MIT, Atlas Cloud）+ Vox 制作方法采访。核心认知：
**拼贴的"样子"诞生在生图 prompt 里，动效是之后加的。图不到位，后面全白搭。**

## 1. 风格选型（bake-off 之前读这节）

一个主题预置 = 一次性锁定整个"看的层"。别所有主题都用一套。五个旋钮，
**年代/艺术运动是最强的单一旋钮**（一次带动配色+字体+版式）：

| 旋钮 | 词库 |
|---|---|
| 媒介 | paper collage · torn-paper collage · photomontage · risograph · screenprint · linocut · halftone print · photocopy/xerox |
| 年代/运动 ⭐ | Swiss/International · Bauhaus · mid-century · Constructivism · Dada photomontage · Pop Art · punk zine · WPA poster · atomic-age · 中式版画/水墨 |
| 版式 | modular grid · asymmetric · strong negative space · diagonal dynamic · hero headline + small caption · stacked bands |
| 配色 ⭐ | limited 2-3 色 · duotone · monochrome + 1 accent · riso 荧光粉+联邦蓝 · Bauhaus 三原色 · 70s mustard/rust · cream/kraft 底 |
| 印刷质感 | halftone dots · Ben-Day dots · riso 套印错位 · letterpress · newsprint · 折痕 · 剪刀边 vs 撕边 |

现成组合参考：`american-retro`（暖米底+红蓝、粗 grotesque）、`swiss-modern`（大量留白、
网格、Helvetica）、`punk-zine`（复印机黑白+一色荧光、ransom-note 字）、`newsprint-editorial`
（报纸底+红笔批注）、`chinese-ink`（宣纸底+木刻+朱印）。库里没有就现调一个——匹配主题的
年代与文化，**不匹配语言**（英文讲中国史照样该中式）。

## 2. 生图 prompt 五段式（gpt-image 出海报/零件）

```
[1 风格块——全片每张相同] Mixed-media hand-cut PAPER COLLAGE, editorial zine style.
  Torn/scissor-cut paper edges, tape corners, halftone print dots, paper-stencil shapes,
  real paper drop shadows. Figures are PRINTED-texture cut-outs (photo/woodblock/mural),
  NOT CGI, NOT 3D render — keep print grain and paper imperfections. High-contrast.
  + 选定主题预置的 媒介/年代/配色/字体 词
[2 场景——按"独立零件"描述] SCENE as layered paper cut-outs: {主体}, {道具}, {文字条},
  {装饰纸片}; clear edges, distinct layers, each with its own drop shadow.
[3 背景] one bold flat {色名} background
[4 标题] headline "确切文字" in {具名字体风格} at {位置} —— 仅当该字由 Remotion 叠加
  有困难时才烧进图；能后期叠的关键文字一律 Remotion 叠（永不糊）
[5 画幅与光] straight-on scanned-flat framing, flat even light, {aspect}
```

规则：不用否定词（gpt-image 正向措辞）；**分层描述越清晰，Remotion 里能拆的视差层越多**；
每张 $0（订阅内），大胆重滚到"真·分层拼贴"为止。

### 独立零件（免抠图技巧）

需要单飞的元素（角色、道具、印章），让 gpt-image **在纯白底上生成单个零件、
无投影、印刷质感**，Remotion 里用 `mix-blend-mode: multiply` 压在纸底上——白底相乘
即消失，印刷质感零件与纸底天然融合，零抠图依赖。需要真透明+白描边贴纸效果时才值得抠。

## 3. 叙事弧（节拍图之前选一条）

| 弧 | 适用 | 节拍形状 |
|---|---|---|
| `hook_payoff` | 任何单一想法，默认最稳 | Hook → Context → Build → Payoff → Button |
| `timeline` | 历史、演化、旅程 | 起点 → 事件 → 转折 → 现在 → 收束 |
| `how_it_works` | 产品/流程讲解 | Hook → 是什么 → 2-3 个展示步骤 → 收益 → CTA |
| `pas` | 痛点广告 | Problem → Agitate → Solve → Proof → CTA |
| `bab` | "之后"比痛点好卖时 | Before → After → Bridge → CTA |
| `storybrand` | 品牌片，客户当主角 | 主角想要 → 阻碍 → 向导 → 方案 → CTA |

节奏铁律：第 1 拍是 ≤3 秒的钩子；**每 4-6 秒一刀**，单镜别超 7 秒；一段旁白 ~8-10 秒
配 2 镜（带标题广角 + 无标题特写），旁白跨镜连续、画面中途切。60 秒 ≈ 6 段 × 2 镜。

## 4. Remotion 动效语汇（代替 AI 视频模型的运动 prompt）

- **步进运动**：编辑拼贴的灵魂是 ~12fps 步进（`useStepped`），像手工定格，不追每帧丝滑。
  丝滑 60fps 缓动反而露 AI 广告味。镜头运动（push/pan）保持全帧率，元素运动步进。
- **每镜一个镜头动作**：slow push-in / lateral pan / parallax truck 三选一，点题镜 static。
  相邻镜头动作要变。
- **元素动词**（纸片语系）：drift · settle · slap（拍上）· fly_in · pivot（刚体转）·
  bob · flutter · 批注 draw-on。禁止 morph/3D 旋转——纸是平的。
- **纹理低频变化**：纸张噪点每 2-3 帧换一次相位（不是每帧），保持"扫描件"而非"渲染件"。
- **英雄飞行元素**（纸鸟横穿全屏之类）只在关键拍点睛一次，每镜都飞就俗。

## 5. 分工速查

| 层 | 谁做 |
|---|---|
| 海报/零件的样子 | gpt-image（五段式 prompt） |
| 相机、视差、组装、揭示 | Remotion `CameraStage` + 组件集 |
| 标题、标注、批注、字幕 | Remotion 叠加（永不烧进图，除非风格需要 ransom-note 等特殊字效） |
| 图表与证据 | Remotion `EditorialChart` / `EvidenceFrame`，数据代码画 |
| 有机微动（人做动作） | 仅该镜走 Seedance `--first-frame`，运动 prompt 用"5 轴"：一个镜头动作 + 纸片层视差 + 保持质感 + 情绪 + 色板，幅度写 subtle，文字区留白 |
