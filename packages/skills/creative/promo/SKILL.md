---
name: promo
disable-model-invocation: true
description: 制作项目宣传物料：Hero/OG/社媒图、商店截图、README 配图和演示 GIF/视频。根据项目现状产出到 design/promo/；应用 UI 用 ui-craft，单独 Logo 用 gpt-image。
---

# Promo（物料工坊）

编排者，自己不生成任何东西：Logo 和 AI 图归 gpt-image、文案归 copywriting + stop-slop、截图归 flow-browser-use/系统工具。本 skill 管的是：搞清项目是什么 → 缺什么物料 → 按正确的工具链生产 → 落盘成套。

## Step 0 — 建立语境（物料质量的上游）

1. 读取用户请求、README、现有界面和品牌资产；`DESIGN.md` 存在时作为线索并与代码核对。仍缺关键信息时只问：项目是什么、给谁用、想要什么气质
2. 判定项目类型（决定截图/录制工具链）：**web / 浏览器扩展 / 桌面 app / CLI-TUI**
3. 盘点已有物料：`design/` 目录、README 里的图、商店页现状

## Step 1 — 出缺口清单，用户挑

按用途列菜单（缺的标出来），等用户挑，不全做：

| 物料                        | 用在哪                              | 分支                          |
| --------------------------- | ----------------------------------- | ----------------------------- |
| Logo / 3D 资产系列          | 应用内、README、社媒头像            | [VISUAL.md](./VISUAL.md) 链 A |
| AI 宣传底图（hero/OG/社媒） | 官网首屏、GitHub social、推文卡片   | [VISUAL.md](./VISUAL.md) 链 B |
| 产品截图（美化合成）        | README hero、商店图库、Product Hunt | [SHOTS.md](./SHOTS.md)        |
| 演示 GIF / 视频             | README、社媒、商店                  | [MOTION.md](./MOTION.md)      |
| 配套文案（标题/口号）       | 叠加在图上、社媒帖                  | copywriting → stop-slop       |

## Step 2 — 生产纪律

- **每个产物生成后必须真实查看**（Read 图片/看视频首末帧），对照验收标准：简洁、高级、现代、单焦点、零 AI 味。不达标改了再看，最多三轮拿给用户挑方向
- 产物落盘 `design/promo/{visual,shots,motion}/`，文件名带用途和尺寸：`hero-github-1280x640.png`
- 全部完成给一张交付清单：文件 → 建议投放位置（README 哪一节、商店哪个位）

## 质量红线

- 图上文字分场景：需要品牌字体一致、中文、长文案、后续还要改词 → HTML 叠加；短英文装饰大字、手写感/涂鸦字可以让 AI 渲染（gpt-image-1 后已可靠），但生成后必须逐字母核对，错一个字母即废图
- 截图内容必须是真实感数据，禁止 lorem ipsum、空列表、测试账号名
- 尺寸必须精确匹配目标平台（表在 SHOTS.md），不许"差不多然后被平台裁烂"
