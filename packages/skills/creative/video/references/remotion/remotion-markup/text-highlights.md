---
name: text-highlights
description: 使用@remotion/rough-notation.的动画文本突出显示和手绘注释
metadata:
  tags: text, highlights, annotations, circles, rough-notation
---

# 文字亮点

使用 `@remotion/rough-notation` 在文本周围或后面绘制动画注释。它支持突出显示、圆圈、下划线、删除线、划线文本、框和括号。

文件：https://www.remotion.dev/docs/text-highlights

使用与项目相同的 Remotion 版本安装包：

```bash
bunx remotion add @remotion/rough-notation
```

选择描述注释的组件：`<Highlight>`、`<Circle>`、`<Underline>`、`<StrikeThrough>`、`<CrossedOff>`、`<Box>` 或 `<Bracket>`。该组件确定注释样式以及它是呈现在文本后面还是顶部。

从 `useCurrentFrame()` 驱动 `progress`，因此注释具有确定性并与视频同步：

```tsx
import {Circle, Highlight} from '@remotion/rough-notation';
import {interpolate, useCurrentFrame} from 'remotion';

export const TextAnnotations: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <div style={{fontSize: 80}}>
      This is{' '}
      <Highlight
        color="rgba(255, 236, 79, 0.62)"
        progress={interpolate(frame, [15, 40], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })}
      >
        important
      </Highlight>
      , and this is{' '}
      <Circle color="#2563eb" progress={interpolate(frame, [15, 40], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })}>
        connected
      </Circle>
      .
    </div>
  );
};
```

保持 `progress` 内联、硬编码并使用 `interpolate` 以获得最大 [Studio 交互性](../remotion-interactivity/guide.md)。
