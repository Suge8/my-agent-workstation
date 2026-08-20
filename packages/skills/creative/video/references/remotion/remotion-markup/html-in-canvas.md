# 在Remotion中使用`<HtmlInCanvas>`

将子项渲染为 `<canvas>`，以便您可以使用 Canvas 2D API 或 WebGL 对它们进行后处理。

仅适用于启用 `chrome://flags/#canvas-draw-element` 标志的 Chrome 149+。
给用户一个通知。

## 嵌套

`<HtmlInCanvas>` 组件可以嵌套在 Chrome 152.0.7944.0 及更高版本中。
较旧的 Chrome 版本支持单个 `<HtmlInCanvas>`，但无法正确绘制嵌套的 HTML 画布子树。

## 在渲染期间启用 WebGL

如果您在渲染期间使用WebGL，则需要启用它：

从CLI：

```bash
npx remotion render --gl=angle
```

将其设置为 Studio 和 CLI 的默认值（建议）：

```ts
import { Config } from "@remotion/cli/config";

Config.setChromiumOpenGlRenderer("angle");
```

## 基本用法

默认情况下，绘制到画布而不应用任何效果：

```tsx
import { HtmlInCanvas } from "remotion";

export const MyComp = () => {
  return (
    <HtmlInCanvas width={1280} height={720}>
      <div style={{ fontSize: 80 }}>Hello</div>
    </HtmlInCanvas>
  );
};
```

## `onPaint` 的 2D 效果

`onPaint` 每当内容更新时运行。调用 `ctx.drawElementImage(elementImage, 0, 0)` 绘制捕获的 DOM，并将返回的变换分配给 `element.style.transform`，以便 DOM 选择仍然与绘制的输出对齐。

```tsx
import {
  AbsoluteFill,
  HtmlInCanvas,
  type HtmlInCanvasOnPaint,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { useCallback } from "react";

export const Blur = () => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();

  const onPaint: HtmlInCanvasOnPaint = useCallback(
    ({ canvas, element, elementImage }) => {
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Failed to acquire 2D context");

      const blurPx = 4 + 18 * (0.5 + 0.5 * Math.sin((frame / fps) * Math.PI));

      ctx.reset();
      ctx.filter = `blur(${blurPx}px)`;
      const transform = ctx.drawElementImage(elementImage, 0, 0);
      element.style.transform = transform.toString();
    },
    [frame, fps],
  );

  return (
    <HtmlInCanvas width={width} height={height} onPaint={onPaint}>
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", fontSize: 120 }}>
        <h1>Hello</h1>
      </AbsoluteFill>
    </HtmlInCanvas>
  );
};
```

## WebGL效果

对于WebGL，在`onInit`中设置上下文、程序和纹理，并返回一个清理函数。在`onPaint`内，上传捕获的DOM和`gl.texElementImage2D(...)`并绘制。

```tsx
const onInit: HtmlInCanvasOnInit = useCallback(({ canvas }) => {
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true });
  if (!gl) {
    throw new Error(
      "WebGL2 unavailable. Try rendering with the --gl=angle option. See https://remotion.dev/docs/gl-options.",
    );
  }
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  // compile program, create texture, set up VAO...
  return () => {
    // delete program, texture, buffers...
  };
}, []);

const onPaint: HtmlInCanvasOnPaint = useCallback(({ elementImage }) => {
  gl.texElementImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, elementImage);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}, []);
```

有关完整工作的最小示例，请参阅 https://github.com/remotion-dev/remotion/blob/main/packages/docs/components/demos/HtmlInCanvasDocsDemoWebGL.tsx.

## 异步`onPaint`

`onPaint`可能是`async`。 Remotion 通过`delayRender()` 保持框架打开，直到承诺解决。对于 `createImageBitmap` 的多通道效果很有用。
