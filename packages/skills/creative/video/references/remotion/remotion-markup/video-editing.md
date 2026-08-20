Remotion 可用于 Studio 中的基本视频编辑。根据您想要的编辑行为选择源结构：

- 移动一个剪辑或调整其大小时，使用独立定位的剪辑不应影响任何其他剪辑。
- 更改一个剪辑的持续时间时使用波纹编辑应重新定位其后的每个剪辑。

将每个可编辑剪辑保留为其自己创作的 JSX 节点。不要使用 `.map()` 或其他编程循环生成可编辑剪辑。

## 独立定位的夹子

将每个`<Video>`直接放置在合成中并对其计时道具进行硬编码。 `from={0}` 可以省略：

```tsx
<Video src="https://remotion.media/video.mp4" trimBefore={0} durationInFrames={78} />
<Video src="https://remotion.media/video.webm" trimBefore={12} from={78} durationInFrames={66} />
<Video src="https://remotion.media/video.mp4" trimBefore={72} from={144} durationInFrames={90} />
<Video src="https://remotion.media/video.webm" trimBefore={58} from={234} durationInFrames={72} />
<Video src="https://remotion.media/video.mp4" trimBefore={180} from={306} durationInFrames={60} />
```

- `from` 是剪辑在其父时间轴中的绝对开始帧。
- `durationInFrames` 是剪辑保持可见的帧数。
- `trimBefore` 是播放开始之前跳过的源帧数。
- 每个`<Video>`必须是一个单独的JSX节点。在 Studio 时间轴中有用时添加描述性 `name`。
- `from`、`durationInFrames` 和 `trimBefore` 必须是硬编码的帧值。不要计算它们。
- 从`@remotion/media`导入`<Video>`。

移动这些剪辑之一或调整其大小不会重新定位后面的剪辑。因此，间隙和重叠是允许的。

## 使用 `TransitionSeries` 进行波纹编辑

“波纹编辑”是标准视频编辑术语，用于更改一个剪辑并自动移动其后的所有内容。
在 Remotion 中，`<TransitionSeries>` 提供了这种顺序的级联时序模型，同时还允许剪辑之间的过渡。

阅读 [transitions.md](transitions.md) 了解过渡类型、计时选项、安装说明和合成持续时间计算。

保持标记如下：

```tsx
<TransitionSeries name="Video timeline">
  <TransitionSeries.Sequence name="Clip 1" durationInFrames={39}>
    <Video
      src="https://remotion.media/video.mp4"
      trimBefore={0}
    />
  </TransitionSeries.Sequence>
  <TransitionSeries.Sequence name="Clip 2" durationInFrames={45}>
    <Video
      src="https://remotion.media/video.webm"
      trimBefore={8}
    />
  </TransitionSeries.Sequence>
  <TransitionSeries.Sequence name="Clip 3" durationInFrames={43}>
    <Video
      src="https://remotion.media/video.mp4"
      trimBefore={60}
    />
  </TransitionSeries.Sequence>
</TransitionSeries>
```

- `<TransitionSeries.Sequence>` 是Studio 时间轴中的可编辑剪辑行。
- 拖动其右边缘会更改 `durationInFrames` 并重新定位每个后续序列。
- 不要将`from`设置为`<TransitionSeries.Sequence>`；该系列计算每个起始帧。
- 对所有数值进行硬编码。
- 不要以编程方式创建多个 `<TransitionSeries.Sequence>`（无 `.map`）。每个实例都必须是硬编码的。
- 从`@remotion/media`导入`<Video>`。从`@remotion/transitions`导入`<TransitionSeries>`。如果需要安装：`npx remotion add @remotion/media @remotion/transitions`
