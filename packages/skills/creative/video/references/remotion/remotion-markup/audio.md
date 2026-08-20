---
name: audio
description: 在 Remotion 中使用音频和声音 - 导入、修剪、音量、速度、音调
metadata:
  tags: audio, media, trim, volume, speed, loop, pitch, mute, sound, sfx
---

# 在 Remotion 中使用音频

## 先决条件

首先，需要安装@remotion/media包。
如果未安装，请使用以下命令：

```bash
npx remotion add @remotion/media
```

## 导入音频

使用 `@remotion/media` 中的 `<Audio>` 将音频添加到您的作品中。

```tsx
import { Audio } from "@remotion/media";
import { staticFile } from "remotion";

export const MyComposition = () => {
  return <Audio src={staticFile("audio.mp3")} />;
};
```

还支持远程 URL：

```tsx
<Audio src="https://remotion.media/audio.mp3" />
```

默认情况下，音频从头开始以最大音量和完整长度播放。
通过添加多个 `<Audio>` 组件可以对多个音轨进行分层。

## 修剪

使用 `trimBefore` 和 `trimAfter` 删除部分音频。值以框架为单位。

```tsx
const { fps } = useVideoConfig();

return (
  <Audio
    src={staticFile("audio.mp3")}
    trimBefore={2 * fps} // Skip the first 2 seconds
    trimAfter={10 * fps} // End at the 10 second mark
  />
);
```

音频仍然从乐曲的开头开始播放 - 仅播放指定的部分。

## 延迟

将音频包裹在 `<Sequence>` 中以在开始时延迟：

```tsx
import { Sequence, staticFile } from "remotion";
import { Audio } from "@remotion/media";

const { fps } = useVideoConfig();

return (
  <Sequence from={1 * fps}>
    <Audio src={staticFile("audio.mp3")} />
  </Sequence>
);
```

音频将在 1 秒后开始播放。

## 体积

设置静态音量（0 到 1）：

```tsx
<Audio src={staticFile("audio.mp3")} volume={0.5} />
```

或者使用基于当前帧的动态音量回调：

```tsx
import { interpolate } from "remotion";

const { fps } = useVideoConfig();

return (
  <Audio
    src={staticFile("audio.mp3")}
    volume={(f) =>
      interpolate(f, [0, 1 * fps], [0, 1], { extrapolateRight: "clamp" })
    }
  />
);
```

当音频开始播放时，`f` 的值从 0 开始，而不是合成帧。

## 静音

使用 `muted` 使音频静音。它可以动态设置：

```tsx
const frame = useCurrentFrame();
const { fps } = useVideoConfig();

return (
  <Audio
    src={staticFile("audio.mp3")}
    muted={frame >= 2 * fps && frame <= 4 * fps} // Mute between 2s and 4s
  />
);
```

## 速度

使用`playbackRate`改变播放速度：

```tsx
<Audio src={staticFile("audio.mp3")} playbackRate={2} /> {/* 2x speed */}
<Audio src={staticFile("audio.mp3")} playbackRate={0.5} /> {/* Half speed */}
```

不支持反向播放。

## 循环播放

使用 `loop` 无限循环音频：

```tsx
<Audio src={staticFile("audio.mp3")} loop />
```

使用 `loopVolumeCurveBehavior` 控制循环时帧计数的行为：

- `"repeat"`：每次循环帧计数重置为 0（默认）
- `"extend"`：帧计数继续递增

```tsx
<Audio
  src={staticFile("audio.mp3")}
  loop
  loopVolumeCurveBehavior="extend"
  volume={(f) => interpolate(f, [0, 300], [1, 0])} // Fade out over multiple loops
/>
```

## 沥青

使用`toneFrequency`调整音高而不影响速度。值范围从 0.01 到 2：

```tsx
<Audio
  src={staticFile("audio.mp3")}
  toneFrequency={1.5} // Higher pitch
/>
<Audio
  src={staticFile("audio.mp3")}
  toneFrequency={0.8} // Lower pitch
/>
```

音高转换仅在服务器端渲染期间起作用，在RemotionStudio预览或`<Player />`中不起作用。
