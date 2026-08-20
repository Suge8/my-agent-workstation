---
name: calculate-metadata
description: 动态设置合成持续时间、尺寸和道具
metadata:
  tags: calculateMetadata, duration, dimensions, props, dynamic
---

# 使用计算元数据

在 `<Composition>` 上使用 `calculateMetadata` 可以在渲染之前动态设置持续时间、尺寸和变换属性。
当元数据依赖于输入属性、获取的数据或资产元数据时使用它。
对于静态维度、持续时间、FPS和初始属性，请内联`<Composition>`上的值。

```tsx
<Composition
  id="MyComp"
  component={MyComponent}
  durationInFrames={300}
  fps={30}
  width={1920}
  height={1080}
  defaultProps={{ videoSrc: "https://remotion.media/video.mp4" }}
  calculateMetadata={calculateMetadata}
/>
```

## 根据视频设置时长

使用[`getVideoDuration`](../mediabunny/get-video-duration.md)和[`getVideoDimensions`](../mediabunny/get-video-dimensions.md)技能获取视频时长和尺寸：

```tsx
import { CalculateMetadataFunction } from "remotion";
import { getVideoDuration } from "./get-video-duration";

const calculateMetadata: CalculateMetadataFunction<Props> = async ({
  props,
}) => {
  const durationInSeconds = await getVideoDuration(props.videoSrc);

  return {
    durationInFrames: Math.ceil(durationInSeconds * 30),
  };
};
```

## 匹配视频的尺寸

使用[`getVideoDimensions`](../mediabunny/get-video-dimensions.md)技能获取视频尺寸：

```tsx
import { CalculateMetadataFunction } from "remotion";
import { getVideoDuration } from "./get-video-duration";
import { getVideoDimensions } from "./get-video-dimensions";

const calculateMetadata: CalculateMetadataFunction<Props> = async ({
  props,
}) => {
  const dimensions = await getVideoDimensions(props.videoSrc);

  return {
    width: dimensions.width,
    height: dimensions.height,
  };
};
```

## 根据多个视频设置时长

```tsx
const calculateMetadata: CalculateMetadataFunction<Props> = async ({
  props,
}) => {
  const metadataPromises = props.videos.map((video) =>
    getVideoDuration(video.src),
  );
  const allMetadata = await Promise.all(metadataPromises);

  const totalDuration = allMetadata.reduce(
    (sum, durationInSeconds) => sum + durationInSeconds,
    0,
  );

  return {
    durationInFrames: Math.ceil(totalDuration * 30),
  };
};
```

## 设置默认的 outName

根据 props 设置默认输出文件名：

```tsx
const calculateMetadata: CalculateMetadataFunction<Props> = async ({
  props,
}) => {
  return {
    defaultOutName: `video-${props.id}`, // .mp4 is added automatically
  };
};
```

## 改造道具

在渲染之前获取数据或变换 props：

```tsx
const calculateMetadata: CalculateMetadataFunction<Props> = async ({
  props,
  abortSignal,
}) => {
  const response = await fetch(props.dataUrl, { signal: abortSignal });
  const data = await response.json();

  return {
    props: {
      ...props,
      fetchedData: data,
    },
  };
};
```

当 Studio 中的 props 发生变化时，`abortSignal` 会取消过时的请求。

## 返回值

所有字段都是可选的。返回值覆盖 `<Composition>` 属性：

- `durationInFrames`：帧数
- `width`：以像素为单位的合成宽度
- `height`：构图高度（以像素为单位）
- `fps`：每秒帧数
- `props`：传递给组件的转换后的 props
- `defaultOutName`：默认输出文件名
- `defaultCodec`：渲染的默认编解码器
