# 生成类视觉资产（Logo 链 + 宣传底图链）

生成工具统一走 gpt-image skill（读它的 SKILL.md 拿调用方式），本文件管**提示词怎么写、流程怎么走**。

## 风格宪法（两条链共用）

提示词是 brief 不是咒语——描述图片要活在哪，比堆形容词有效。每个提示词必含四要素：

1. **用途与位置**："background for a website hero section, wide crop safe, generous empty area on the left for headline text"——留白位置跟着最终排版走
2. **构图**：单焦点、不对称构图、大面积留白（active negative space）
3. **气质**：优先沿用现有界面和品牌资产；`DESIGN.md` 存在时可取其色板和情绪词，否则根据项目选择明确方向
4. **比例**：按目标平台横竖版指定

**反 AI 味负面清单（每个提示词末尾附加）**：no text, no letters, no watermark, no busy details, no oversaturated neon, no glossy plastic 3D render look, no fake lens flare, no cluttered composition。

**迭代纪律**：先构图对（粗看布局和留白），再调细节，最后收气质——一次只改一个方向；生成即看图，不满意说清哪里不满意再改提示词，禁止盲目重摇。

## 链 A — Logo → 3D 资产（五步，CuePad 验证过的流程）

1. **选板**：用 gpt-image 的 Logo 指南生成提案板（一板多方案）
2. **用户挑**：等用户选中一个，不许代选
3. **放大重绘**：把选中的单个 logo 以更高精度单独重绘——提示词描述该 logo 的图形结构（几何构成、黑白关系），要求 1:1 单体、干净背景、矢量感锐利边缘
4. **拟人化/立体化**：以重绘稿为基准生成 3D 化提示词——soft matte material, subtle studio lighting, gentle depth, friendly character（要拟人时），保持原图形的辨识结构不走形
5. **资产系列**：确认单体满意后，批量出场景变体（不同角度/姿态/情绪），每张都基于同一描述骨架只换变量，保证系列一致性

产物：`design/promo/visual/logo-*.png`、`asset-*.png`。

## 链 B — AI 宣传底图（hero / OG / 社媒）

底图 = 无文字的氛围图，文字和产品截图后期在 SHOTS.md 的 HTML 管线叠加。

提示词骨架（填空即用）：

> Abstract background for {用途: website hero / social card}, {构图: single focal gradient orb lower right, vast negative space upper left for headline}, {气质: 从现有品牌或界面挑 2-3 色 + 与项目匹配的 mood}, {质感: soft gradient mesh / subtle grain / matte}, {比例}. No text, no letters, no watermark, no busy details, no oversaturated neon, no glossy plastic 3D look.

可靠的风格方向（按项目气质选一，不混用）：

- **柔和渐变场**：soft gradient mesh, 2-3 brand colors, subtle grain——万金油，适合 SaaS/工具
- **几何极简**：flat geometric shapes, swiss composition, restrained palette, visible grid rhythm——适合开发者工具
- **单体 3D 焦点**：one matte 3D object (链 A 的资产!) floating, soft studio light, seamless background——把自家 3D 资产当主角，品牌一致性最强
- **微噪点纯色**：near-solid color field with fine grain and one soft light source——最克制，配大标题

产物：`design/promo/visual/bg-{用途}-{尺寸}.png`，交给 SHOTS.md 合成。
