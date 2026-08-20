---
name: embedding-videos
description: 将视频嵌入 Remotion - 修剪、音量、速度、循环、音高
metadata:
  tags: video, media, trim, volume, speed, loop, pitch
---

# 使用Remotion中的视频

## 先决条件

首先，需要安装@remotion/media包。
如果不是，请使用以下命令：

```bash
npx remotion add @remotion/media # If project uses npm
bunx remotion add @remotion/media # If project uses bun
yarn remotion add @remotion/media # If project uses yarn
pnpm exec remotion add @remotion/media # If project uses pnpm
```

使用 `@remotion/media` 中的 `<Video>` 将视频嵌入到您的作品中。

```tsx
import { Video } from "@remotion/media";
import { staticFile } from "remotion";

export const MyComposition = () => {
  return <Video src={staticFile("video.mp4")} />;
};
```

还支持远程 URL：

```tsx
<Video src="https://remotion.media/video.mp4" />
```

## 修剪

使用 `trimBefore` 和 `trimAfter` 删除视频的部分内容。值以秒为单位。

```tsx
const { fps } = useVideoConfig();

return (
  <Video
    src={staticFile("video.mp4")}
    trimBefore={2 * fps} // Skip the first 2 seconds
    trimAfter={10 * fps} // End at the 10 second mark
  />
);
```

## 延迟

将视频包裹在 `<Sequence>` 中以延迟其出现：

```tsx
import { Sequence, staticFile } from "remotion";
import { Video } from "@remotion/media";

const { fps } = useVideoConfig();

return (
  <Sequence from={1 * fps}>
    <Video src={staticFile("video.mp4")} />
  </Sequence>
);
```

1 秒后将出现视频。

## 尺寸和位置

使用 `style` 属性来控制大小和位置：

```tsx
<Video
  src={staticFile("video.mp4")}
  style={{
    width: 500,
    height: 300,
    position: "absolute",
    top: 100,
    left: 50,
  }}
  objectFit="cover"
/>
```

## 体积

设置静态音量（0 到 1）：

```tsx
<Video src={staticFile("video.mp4")} volume={0.5} />
```

或者使用基于当前帧的动态音量回调：

```tsx
import { interpolate } from "remotion";

const { fps } = useVideoConfig();

return (
  <Video
    src={staticFile("video.mp4")}
    volume={(f) =>
      interpolate(f, [0, 1 * fps], [0, 1], { extrapolateRight: "clamp" })
    }
  />
);
```

使用 `muted` 使视频完全静音：

```tsx
<Video src={staticFile("video.mp4")} muted />
```

## 速度

使用`playbackRate`改变播放速度：

```tsx
<Video src={staticFile("video.mp4")} playbackRate={2} /> {/* 2x speed */}
<Video src={staticFile("video.mp4")} playbackRate={0.5} /> {/* Half speed */}
```

不支持反向播放。

## 循环播放

使用 `loop` 无限循环播放视频：

```tsx
<Video src={staticFile("video.mp4")} loop />
```

使用 `loopVolumeCurveBehavior` 控制循环时帧计数的行为：

- `"repeat"`：每次循环帧计数重置为 0（对于 `volume` 回调）
- `"extend"`：帧计数继续递增

```tsx
<Video
  src={staticFile("video.mp4")}
  loop
  loopVolumeCurveBehavior="extend"
  volume={(f) => interpolate(f, [0, 300], [1, 0])} // Fade out over multiple loops
/>
```

## 沥青

使用`toneFrequency`调整音高而不影响速度。值范围从 0.01 到 2：

```tsx
<Video
  src={staticFile("video.mp4")}
  toneFrequency={1.5} // Higher pitch
/>
<Video
  src={staticFile("video.mp4")}
  toneFrequency={0.8} // Lower pitch
/>
```

音高转换仅在服务器端渲染期间起作用，在RemotionStudio预览或`<Player />`中不起作用。
