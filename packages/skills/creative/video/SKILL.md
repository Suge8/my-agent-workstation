---
name: video
description: 视频统一入口：把主题策划成运动优先的动画、用 Remotion 实现与渲染，或通过 Grok/Seedance 直接生成带音轨 MP4。用户要视频、短片、动画方案、动态分镜或 Remotion 开发时使用；静态图片用 gpt-image。
---

# Video

先判断用户要的是哪条路线，只读取对应参考：

- **导演与完整制作**：主题、文章或 brief 要转成运动隐喻、节拍、导演板和成片，读取 [导演工作流](references/director.md)。
- **Remotion 工程**：composition、Studio、字幕、Player、渲染或多媒体处理，读取 [Remotion 路由](references/remotion.md)，再按其中指针读取 `references/remotion/` 下对应指南。
- **模型直出**：用户要快速生成实拍感或生成式短 MP4，读取 [模型生成](references/model-generation.md)。

完整制作可以先走导演路线，再进入 Remotion 或模型直出；不要同时加载全部参考。所有成片在交付前都要真实查看关键帧并核对音轨、比例、时长和输出路径。
