---
name: compositions
description: 定义构图、剧照、文件夹、默认道具和动态元数据
metadata:
  tags: composition, still, folder, props, metadata
---

`<Composition>` 定义可渲染视频的组件、宽度、高度、fps 和持续时间。

## 默认 Props 和脚手架元数据

传递 `defaultProps` 为您的组件提供初始值。
值必须是JSON可序列化（支持`Date`、`Map`、`Set`和`staticFile()`）。
使用 `defaultProps` 来表示在视频渲染之前应可见且可编辑的合成范围值。

对于 Studio 编辑，请将 `defaultProps` 保留为 `<Composition>` 或 `<Still>` 上的内联对象文字。
不要将其存储在变量中、导入它、传播它、使用助手创建它或将其包装在 `satisfies` 中。
搭建时，将组件和 `<Composition>` 注册保存在同一个文件中，以便 `width`、`height`、`fps`、`durationInFrames` 和 `defaultProps` 在使用它们的代码旁边可见。
使用 `type` 声明 props 而不是 `interface` 来确保 `defaultProps` 类型安全。

```tsx
type Props = {
  readonly title: string;
};

export const MyComposition = ({ title }: Props) => <h1>{title}</h1>;

const defaultProps = { title: "Hello World" };

// 👍 Inline metadata and defaults
<Composition
  id="MyComposition"
  component={MyComposition}
  durationInFrames={100}
  fps={30}
  width={1080}
  height={1080}
  defaultProps={{ title: "Hello World" }}
/>;

// 👎 Hidden defaults cannot be saved back by Studio
<Composition
  id="OtherComposition"
  component={MyComposition}
  durationInFrames={100}
  fps={30}
  width={1080}
  height={1080}
  defaultProps={defaultProps}
/>;
```

## 文件夹

使用 `<Folder>` 组织侧边栏中的作品。
文件夹名称只能包含字母、数字和连字符。

```tsx
import { Composition, Folder } from "remotion";

export const RemotionRoot = () => {
  return (
    <>
      <Folder name="Marketing">
        <Composition id="Promo" /* ... */ />
        <Composition id="Ad" /* ... */ />
      </Folder>
      <Folder name="Social">
        <Folder name="Instagram">
          <Composition id="Story" /* ... */ />
          <Composition id="Reel" /* ... */ />
        </Folder>
      </Folder>
    </>
  );
};
```

## 剧照

对于单帧图像使用 `<Still>`。它不需要`durationInFrames`或`fps`。

```tsx
import { Still } from "remotion";
import { Thumbnail } from "./Thumbnail";

export const RemotionRoot = () => {
  return (
    <Still id="Thumbnail" component={Thumbnail} width={1280} height={720} />
  );
};
```

## 动态持续时间、宽度和高度

使用 [`calculateMetadata`](./calculate-metadata.md) 根据输入 props、获取的数据或资产元数据使维度、持续时间或 props 动态化。

## 将作品嵌套在另一个作品中

要在另一个合成中添加合成，您可以使用 `<Sequence>` 组件以及 `width` 和 `height` 属性来指定合成的大小。

```tsx
<AbsoluteFill>
  <Sequence width={COMPOSITION_WIDTH} height={COMPOSITION_HEIGHT}>
    <CompositionComponent />
  </Sequence>
</AbsoluteFill>
```
