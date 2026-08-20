---
name: trimming
description: Remotion 的修剪模式 - 剪切动画的开头或结尾
metadata:
  tags: sequence, trim, clip, cut, offset
---

使用 `<Sequence>` 和负 `from` 值来修剪动画的开头。

## 修剪开头部分

负 `from` 值会将时间向后移动，使动画在中途开始：

```tsx
import { Sequence, useVideoConfig } from "remotion";

const fps = useVideoConfig();

<Sequence from={-0.5 * fps}>
  <MyAnimation />
</Sequence>;
```

动画在播放过程中出现 15 帧 - 前 15 帧被修剪掉。
在 `<MyAnimation>` 内，`useCurrentFrame()` 从 15 而不是 0 开始。

## 修剪末端

使用 `durationInFrames` 在指定的持续时间后卸载内容：

```tsx
<Sequence durationInFrames={1.5 * fps}>
  <MyAnimation />
</Sequence>
```

动画播放 45 帧，然后组件卸载。

## 修剪和延迟

嵌套序列以在出现时修剪开头和延迟：

```tsx
<Sequence from={30}>
  <Sequence from={-15}>
    <MyAnimation />
  </Sequence>
</Sequence>
```

内部序列从开始处修剪 15 帧，外部序列将结果延迟 30 帧。
