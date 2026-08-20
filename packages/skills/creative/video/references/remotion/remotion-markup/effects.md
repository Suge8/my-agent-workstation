---
name: effects
description: 使用效果数组和 createEffect() 为 Remotion 提供Canvas/WebGL 视觉效果。
metadata:
  tags: effects, visual-effects, webgl, canvas, video, create-effect
---

仅当顶级技能列出与请求的外观匹配的效果时，或者当用户要求创建可重用的自定义效果时，才使用此规则。

文件：https://www.remotion.dev/docs/effects
自定义效果文档：https://www.remotion.dev/docs/create-effect

## 用法

安装提供所选效果的包：

```bash
npx remotion add @remotion/effects
```

使用`npx remotion add @remotion/light-leaks`代表`lightLeak()`，使用`npx remotion add @remotion/starburst`代表`starburst()`。

效果是传递给基于画布的组件的 `effects` 属性的函数，例如来自 `@remotion/media`、`<Solid>`、`<CanvasImage>` 和 `<HtmlInCanvas>` 的 `<Video>`。

```tsx
import {Video} from '@remotion/media';
import {blur} from '@remotion/effects/blur';

<Video src="https://remotion.media/video.mp4" effects={[blur({radius: 8})]} />;
```

使用效果文档来获取精确的道具和导入。大多数`@remotion/effects`导入使用`@remotion/effects/<effect-slug>`； `uvTranslate()`和`xyTranslate()`使用`@remotion/effects/translate`； `lightLeak()`使用`@remotion/light-leaks`； `starburst()` 使用`@remotion/starburst`。

这些效果使用 WebGL2。在渲染期间，启用 WebGL：

```ts
import {Config} from '@remotion/cli/config';

Config.setChromiumOpenGlRenderer('angle');
```

## 自定义效果

当用户想要一个可重用的效果工厂与 `@remotion/effects` 在相同的 `effects` 数组中工作时，请使用 `remotion` 中的 `createEffect()`。

当转换应该可重用、参数化、可在 Studio 中编辑或可与其他效果堆叠时，优先选择自定义效果而不是 `<HtmlInCanvas onPaint>`。

要快速获得特定于项目的效果，请将效果保留在合成旁边，例如 `src/effects/palette-map.ts`。对于用于 `@remotion/effects` 的库效果，请遵循存储库的 `add-effect` 技能。

`createEffect()`期望：

- `type`：稳定的反向DNS标识符，例如`com.example.paletteMap`。
- `label`：Studio标签，常见为`paletteMap()`。
- `documentationLink`：URL或`null`。
- `backend`：`"2d"`、`"webgl2"` 或 `"webgpu"`。
- `calculateKey(params)`：包含每个更改输出的已解析参数的稳定字符串。
- `setup(target)`：创建可重用的后端状态，或返回`null`。
- `apply({source, target, width, height, params, state, flipSourceY})`：将变换后的结果绘制到`target`。
- `cleanup(state)`：`setup()`创建的免费资源。
- `schema`：`InteractivitySchema` 用于 Studio 控件。 `disabled` 会自动添加。
- `validateParams(params)`：抛出缺失值或无效值。

使用 `backend: "2d"` 实现简单的像素、滤镜、drawImage 或图像数据效果。仅当需要着色器数学或 GPU 性能时才使用 WebGL2；在渲染期间，启用WebGL，如上所示。

```ts
import {createEffect, type InteractivitySchema} from 'remotion';

type MyEffectParams = {
  readonly amount?: number;
};

const myEffectSchema = {
  amount: {
    type: 'number',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    description: 'Amount',
  },
} as const satisfies InteractivitySchema;

const resolve = (params: MyEffectParams) => ({
  amount: params.amount ?? 1,
});

export const myEffect = createEffect<MyEffectParams, null>({
  type: 'com.example.myEffect',
  label: 'myEffect()',
  documentationLink: null,
  backend: '2d',
  calculateKey: (params) => {
    const {amount} = resolve(params);
    return `my-effect-${amount}`;
  },
  setup: () => null,
  apply: ({source, target, width, height, params}) => {
    const ctx = target.getContext('2d');
    if (!ctx) {
      throw new Error('Could not get a 2D context for myEffect().');
    }

    const {amount} = resolve(params);

    ctx.clearRect(0, 0, width, height);
    ctx.filter = `opacity(${amount * 100}%)`;
    ctx.drawImage(source, 0, 0, width, height);
    ctx.filter = 'none';
  },
  cleanup: () => undefined,
  schema: myEffectSchema,
  validateParams: ({amount = 1}) => {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 1) {
      throw new TypeError('amount must be a number between 0 and 1');
    }
  },
});
```

对于 WebGL2 效果，`setup()` 中的 compile/link 着色器，保持程序、全屏四边形、纹理和统一位置的状态，在 `apply()` 中上传 `source`，并在 `cleanup()` 中释放 GPU 资源。最小形状：

```ts
import {createEffect, type InteractivitySchema} from 'remotion';

type RgbShiftParams = {
  readonly amount?: number;
};

type RgbShiftState = {
  readonly gl: WebGL2RenderingContext;
  readonly program: WebGLProgram;
  readonly vao: WebGLVertexArrayObject;
  readonly vbo: WebGLBuffer;
  readonly texture: WebGLTexture;
  readonly uSource: WebGLUniformLocation | null;
  readonly uOffset: WebGLUniformLocation | null;
};

const rgbShiftSchema = {
  amount: {
    type: 'number',
    min: 0,
    max: 80,
    step: 1,
    default: 12,
    description: 'Amount',
  },
} as const satisfies InteractivitySchema;

export const rgbShift = createEffect<RgbShiftParams, RgbShiftState>({
  type: 'com.example.rgbShift',
  label: 'rgbShift()',
  documentationLink: null,
  backend: 'webgl2',
  calculateKey: ({amount = 12}) => `rgb-shift-${amount}`,
  setup: (target) => {
    const gl = target.getContext('webgl2', {
      premultipliedAlpha: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    if (!gl) {
      throw new Error('Could not get a WebGL2 context for rgbShift().');
    }

    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

    // Compile/link shaders, create a fullscreen quad VAO/VBO, create a
    // CLAMP_TO_EDGE RGBA texture, and get uSource/uOffset uniform locations.
    return createRgbShiftState(gl);
  },
  apply: ({source, width, height, params, state, flipSourceY}) => {
    const amount = params.amount ?? 12;
    const {gl} = state;

    gl.viewport(0, 0, width, height);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipSourceY);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, state.texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      source as TexImageSource,
    );

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(state.program);
    if (state.uSource) gl.uniform1i(state.uSource, 0);
    if (state.uOffset) gl.uniform2f(state.uOffset, amount / width, 0);
    gl.bindVertexArray(state.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  },
  cleanup: ({gl, program, vao, vbo, texture}) => {
    gl.deleteTexture(texture);
    gl.deleteBuffer(vbo);
    gl.deleteProgram(program);
    gl.deleteVertexArray(vao);
  },
  schema: rgbShiftSchema,
  validateParams: ({amount = 12}) => {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 80) {
      throw new TypeError('amount must be a number between 0 and 80');
    }
  },
});
```

有关完整的 2D 和 WebGL2 对，请参阅 `packages/example/src/EffectsTestbed/sample-posterize-2d.ts` 和 `packages/example/src/EffectsTestbed/sample-rgb-shift-webgl.ts`。

在 `effects` 数组中使用返回的工厂：

```tsx
import {CanvasImage, staticFile} from 'remotion';
import {myEffect} from './effects/my-effect';

export const MyComp: React.FC = () => {
  return (
    <CanvasImage
      src={staticFile('image.png')}
      effects={[myEffect({amount: 0.8})]}
    />
  );
};
```

生成自定义效果时，还可以：

- 仅通过返回工厂包含`disabled?: boolean`；不要将其添加到自定义参数类型或架构中。
- 使用 `validateParams` 在工厂调用时验证所需参数。
- 在 `schema` 和 `resolve()` 帮助器中包含所有默认值。
- 绘制后重置可变的 2D 上下文状态，例如 `filter`、`globalAlpha`、变换和合成。
- 保留 Alpha，除非所请求的效果有意改变透明度。
