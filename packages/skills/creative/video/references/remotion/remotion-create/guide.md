# Remotion 创建

创建新的 Remotion 视频

这些是制作新 Remotion 项目与 composition 的说明。
若不是下一步任务，见 [Remotion 最佳实践](../../../SKILL.md)。

## 搭建项目

若项目已存在，跳过本节。
确保已安装 Node.js 与 Git，且当前目录适合新建项目。

默认使用当前项目目录：目录里已有 Remotion 项目时直接使用，不要重复脚手架。

新建时：

```bash
npx create-video@latest --yes --blank --no-tailwind my-video
cd my-video
npm i
```

将 `my-video` 换成合适的项目名。

## 设计视频

保留脚手架并添加 React 标记。请遵循 [Remotion React 标记最佳实践](../remotion-markup/guide.md) 和 [视频布局规则](video-layout.md) 以获取视频优先布局和文本大小调整指南。

## 交互最佳实践

通过按照 [Remotion 交互最佳实践](../remotion-interactivity/guide.md) 构造 React 标记，您允许用户在 Studio 中进行编辑并写回代码。

## TailwindCSS

如果需要Tailwind，请参见[tailwind.md](tailwind.md)在Remotion中使用TailwindCSS。

## 开始预览

```bash
npx remotion studio --no-open
```

这会启动长驻进程，并打印 Studio 预览 URL。

## 跟进

脚手架与初版 composition 完成后，后续改动回到 [Remotion 最佳实践](../../../SKILL.md)。
