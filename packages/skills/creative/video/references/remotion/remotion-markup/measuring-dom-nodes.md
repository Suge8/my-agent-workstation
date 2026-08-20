---
name: measuring-dom-nodes
description: 测量 Remotion 中的 DOM 元素尺寸
metadata:
  tags: measure, layout, dimensions, getBoundingClientRect, scale
---

# 测量 Remotion 中的 DOM 节点

Remotion 将 `scale()` 变换应用于视频容器，这会影响`getBoundingClientRect()` 中的值。使用 `useCurrentScale()` 获得正确的测量结果。

## 测量元件尺寸

```tsx
import { useCurrentScale } from "remotion";
import { useRef, useEffect, useState } from "react";

export const MyComponent = () => {
  const ref = useRef<HTMLDivElement>(null);
  const scale = useCurrentScale();
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    setDimensions({
      width: rect.width / scale,
      height: rect.height / scale,
    });
  }, [scale]);

  return <div ref={ref}>Content to measure</div>;
};
```
