# Remotion 最佳实践

Remotion 的领域知识入口。按任务只加载对应参考，不要一次读完整个目录。

## 本地约束

- 这是唯一可发现入口。`references/remotion/` 下的模块是按需路由，不是独立 Skill。
- 禁止把嵌套 `guide.md` 提升为独立 active skill，禁止 `npx skills add remotion-dev/skills` 直装覆盖本目录。
- 文中相对路径以本 Skill 目录为准。
- 本参考只管 Remotion 代码与工具链；运动导演和模型直出分别由本 Skill 的 `references/director.md`、`references/model-generation.md` 负责。

## 新项目

若还没有 Remotion 项目，加载 [创建 Remotion 项目](references/remotion/remotion-create/guide.md)。

内容工作台使用当前视频项目根目录（已有项目则直接在其中改，勿重复脚手架）。

## React 标记

编写 Remotion React 标记时，加载 [Remotion 标记最佳实践](references/remotion/remotion-markup/guide.md)。

## Mediabunny

浏览器内多媒体（裁剪、截取、读元数据等）加载 [Mediabunny 最佳实践](references/remotion/mediabunny/guide.md)。

## 交互

若希望 Studio 里可点选、可改并写回代码，加载 [交互最佳实践](references/remotion/remotion-interactivity/guide.md)。

## 渲染

超出简单 `npx remotion render` 的高级渲染，见 [渲染最佳实践](references/remotion/remotion-render/guide.md)。

## 字幕

处理字幕时加载 [Remotion 字幕](references/remotion/remotion-captions/guide.md)。

## SaaS / 自动化 / 应用

做 Remotion 驱动的应用（`<Player>`、Lambda/Vercel/Cloudflare/Express、客户端渲染或选 SaaS 模板）时，用 [Remotion SaaS](references/remotion/remotion-saas/guide.md)。

## 查文档

需要当前 API 与官方文档时，加载 [Remotion Docs](references/remotion/remotion-docs/guide.md)。
