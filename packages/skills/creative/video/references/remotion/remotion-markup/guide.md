# Remotion 标记

编写 Remotion React 标记的最佳实践

这是编写 Remotion React 标记的指南。
如果这不相关，请改为加载 [Remotion 最佳实践](../../../SKILL.md)。

## 一般规则

使用 `useCurrentFrame()` 和 `interpolate()` 对属性进行动画处理。

使用`interpolate()`超过`spring()`。

使用 `Easing.bezier()` 自定义计时，包括跳跃或过冲运动。
如果你想要弹簧动画，请使用`Easing.spring()`

HTML 在 Studio 中有意义的交互元素应使用 `Interactive`：`<div>` -> `<Interactive.Div>`。
设置描述性 `name` 属性，例如为 `Interactive`、`Solid`、`Sequence` 设置`name="Hero title"`。

```tsx
import { useCurrentFrame, Easing, interpolate, Interactive } from "remotion";

export const FadeIn = () => {
  const frame = useCurrentFrame();

  return (
    <Interactive.Div
      name="Title"
      style={{
        opacity: interpolate(frame, [0, 60], [0, 1], {
          extrapolateRight: "clamp",
          extrapolateLeft: "clamp",
          easing: Easing.bezier(0.16, 1, 0.3, 1),
        }),
      }}
    >
      Hello World!
    </Interactive.Div>
  );
};
```

将 `interpolate()` 调用保持在 `style` 属性中内联。
与 `transform` 相比，更喜欢 `scale`、`translate`、`rotate` CSS 属性。

```tsx
// 👍 Inline editable keyframes and transform shorthands
style={{
  scale: interpolate(frame, [0, 100], [0, 1]),
  translate: interpolate(frame, [0, 100], ["0px 0px", "100px 100px"]),
  rotate: interpolate(frame, [0, 100], ["20deg", "90deg"]),
}}

// 👎 Hidden values and transform strings become harder to edit in Studio
const scale = interpolate(frame, [0, 100], [0, 1]);

style={{
  transform: `scale(${scale})`,
}}
```

CSS 过渡或动画为 FORBIDDEN - 它们将无法正确渲染。
Tailwind 动画类名称为 FORBIDDEN - 它们将无法正确渲染。

将资源放置在项目根目录的 `public/` 文件夹中。

使用 `staticFile()` 引用 `public/` 文件夹中的文件。

使用 `@remotion/media` 添加视频和音频。
使用 `<Img>` 组件添加图像。
对`public/`中的文件使用`staticFile()`或直接传递远程URL：

```tsx
import { Audio, Video } from "@remotion/media";
import { staticFile } from "remotion";

export const MyComposition = () => {
  return (
    <>
      <Video src={staticFile("video.mp4")} style={{ opacity: 0.5 }} />
      <Audio src={staticFile("audio.mp3")} />
      <Img src={staticFile("logo.png")} style={{ width: 100, height: 100 }} />
      <Video src="https://remotion.media/video.mp4" />
    </>
  );
};
```

要延迟内容，请将其包装在 `<Sequence>` 中并使用 `from`。
要限制元素的持续时间，请使用 `<Sequence>` 的 `durationInFrames`。
默认情况下，`<Sequence>`是覆盖场景的绝对填充。
对于内联内容，请使用 `layout="none"`。

```tsx
const Main = () => {
  const {fps} = useVideoConfig();

  return (
    <AbsoluteFill>
      <Sequence name="Background">
        <Background />
      </Sequence>
      <Sequence name="Title" from={30} durationInFrames={60} layout="none">
        <Title />
      </Sequence>
      <Sequence name="Subtitle" from={60} durationInFrames={60} layout="none">
        <Subtitle />
      </Sequence>
    </AbsoluteFill>
  );
}

export const Title = () => {
  const frame = useCurrentFrame();

  return (
    <div
      style={{
        opacity: interpolate(frame, [0, 60], [0, 1], {
          extrapolateRight: "clamp",
          extrapolateLeft: "clamp",
          easing: Easing.bezier(0.16, 1, 0.3, 1),
        }),
      }}
    >
      Title
    </div>
  );
};

export const Subtitle = () => {
  return <div>Subtitle</div>;
};
```

## 地图

请参阅 [map.md](map.md) 在简单静态地图、Mapbox 地图和 MapLibre 地图之间进行选择。

## 文本突出显示和注释

请参阅 [text-highlights.md](text-highlights.md) 了解文本突出显示（突出显示标记）、圆圈、下划线、删除线、划掉的文本、框和括号。

## 画外音

请参阅 [voiceover.md](voiceover.md)，了解使用 ElevenLabs TTS 将 AI 生成的画外音添加到 Remotion 作品中。

## 修剪

请参阅 [trimming.md](trimming.md) 了解修剪模式 - 剪切动画的开头或结尾。

## 嵌入视频

请参阅 [embedding-videos.md](embedding-videos.md) 了解有关嵌入视频的高级知识 - 修剪、音量、速度、循环、音高。

## 视频编辑

有关在 Remotion Studio 中构建可编辑视频时间线的信息，请参阅 [video-editing.md](video-editing.md)。

## 嵌入音频

请参阅 [audio.md](audio.md) 了解高级音频功能，如修剪、音量、速度、音高。

## 过渡

有关场景过渡模式，请参阅 [transitions.md](transitions.md)。

## 视觉和像素效果

创建视觉效果时，首选： 1. 普通 Remotion/HTML/CSS/SVG/filter/blend/mask 动画，2. 通过 [effects.md](effects.md) 列出的效果，包括通过 `<HtmlInCanvas>` 渲染的 HTML，3. 当用户请求 reusable/project-specific 效果时，通过 [effects.md](effects.md) 自定义 `createEffect()`，4.仅当没有效果适合时才通过 [html-in-canvas.md](html-in-canvas.md) 自定义 `<HtmlInCanvas onPaint>`。

对于漏光叠加，请参阅 [light-leaks.md](light-leaks.md)。文件：https://www.remotion.dev/docs/effects

可用效果：`brightness()`、`contrast()`、`colorKey()`、`duotone()`、`grayscale()`、`hue()`、`invert()`、`saturation()`、`tint()`、`linearGradient()`、`linearGradientTint()`、`thermalVision()`、 `blur()`、`linearProgressiveBlur()`、`radialProgressiveBlur()`、`zoomBlur()`、`dropShadow()`、`glow()`、`lightTrail()`、`evolve()`、`venetianBlinds()`、`mirror()`、`scale()`、 `uvTranslate()`、`xyTranslate()`、`barrelDistortion()`、`chromaticAberration()`、`fisheye()`、`cornerPin()`、`wave()`、`burlap()`、`emboss()`、`dotGrid()`、`halftone()`、 `noise()`、`noiseDisplacement()`、`paper()`、`roughenEdges()`、`pattern()`、`pixelate()`、`pixelDissolve()`、`scanlines()`、`speckle()`、`shine()`、`shrinkwrap()`、 `vignette()`、`contourLines()`、`checkerboard()`、`halftoneLinearGradient()`、`gridlines()`、`whiteNoise()`、`tvSignalOff()`、`lines()`、`rings()`、`waves()`、`zigzag()`、 `lightLeak()`，`starburst()`。

## 3D内容

有关使用 Three.js 和 React 三光纤的 Remotion 中的 3D 内容，请参阅 [3d.md](3d.md)。

## 音效

当需要使用音效时，请加载[./sfx.md](./sfx.md)文件以获取更多信息。

## 音频可视化

当需要可视化音频（频谱条、波形、低音反应效果）时，加载 [./audio-visualization.md](./audio-visualization.md) 文件以获取更多信息。

## 字幕

处理字幕或副标题时，请加载[Remotion字幕](../remotion-captions/guide.md)技能以获取更多信息。

## Google Fonts

是在 Remotion 中加载字体的推荐方法。请参阅 [google-fonts.md](google-fonts.md) 了解如何加载 Google Fonts。

## 本地字体

如何加载本地字体请参见[local-fonts.md](local-fonts.md)。

## 动图

请参阅 [gifs.md](gifs.md) 了解如何显示与 Remotion 时间线同步的 GIF。

## 高级图像

请参阅 [images.md](images.md) 了解图像大小和定位、动态图像路径以及获取图像尺寸。

## Lottie 动画

有关在 Remotion 中嵌入 Lottie 动画的信息，请参阅 [lottie.md](lottie.md)。

## 高级计时

请参阅 [timing.md](timing.md) 了解使用 `interpolate` 和贝塞尔曲线缓动以及弹簧的高级计时。

## 参数化视频

请参阅 [parameters.md](parameters.md) 通过添加 Zod 模式使组合可参数化。

## 测量DOM个节点

请参阅 [measuring-dom-nodes.md](measuring-dom-nodes.md) 来测量 Remotion 中的 DOM 元素尺寸。

## 测量文本

请参阅 [measuring-text.md](measuring-text.md) 了解测量文本尺寸、使文本适合容器以及检查溢出。

## 使用FFmpeg

对于某些视频操作，例如修剪视频或检测静音，应使用FFmpeg。加载 [./ffmpeg.md](./ffmpeg.md) 文件以获取更多信息。

## 静音检测

当需要检测和修剪视频或音频文件中的无声片段时，加载[./silence-detection.md](./silence-detection.md)文件。

## 动态持续时间、维度和数据

请参阅 [calculate-metadata.md](calculate-metadata.md) 了解动态设置合成持续时间、维度和道具。

## 高级作文

请参阅 [compositions.md](compositions.md) 了解如何定义剧照、文件夹、默认道具以及如何嵌套合成。

## 高级测序

请参阅 [sequencing.md](sequencing.md) 了解更多排序模式 - 延迟、修剪、限制项目持续时间。

## 安装模块

使用 `npx remotion add` 添加具有正确版本的新包：

```
npx remotion add @remotion/media
```

这适用于 `@remotion/*` 软件包、`mediabunny`、`@mediabunny/*` 和 `zod`。

## 预览标记

仅当您认为用户想要查看预览时才执行此操作。

```bash
npx remotion studio --no-open
```

这将启动一个长时间运行的进程并打印服务器URL以进行预览。
如果已经启动，将打印URL。

## 可选：一帧渲染检查

您可以使用 CLI 渲染单个帧，以检查布局、颜色或时间。
对于琐碎的编辑、纯粹的重构，或者当您已经对 Studio 或之前的渲染有足够的信心时，请跳过它。

```bash
npx remotion still [composition-id] --scale=0.25 --frame=30
```

在 30 fps 时，`--frame=30` 是一秒标记（`--frame` 从零开始）。
