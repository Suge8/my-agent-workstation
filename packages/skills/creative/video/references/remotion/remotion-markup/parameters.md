---
name: parameters
description: 通过添加 Zod 架构使视频可参数化
metadata:
  tags: parameters, zod, schema
---

为了使视频可参数化，可以将 Zod 模式添加到合成中。

首先，必须安装`zod`。

在项目中搜索锁定文件并根据包管理器运行正确的命令：

如果找到`package-lock.json`，请使用以下命令：

```bash
npm i zod
```

如果找到`bun.lockb`，请使用以下命令：

```bash
bun i zod
```

如果找到`yarn.lock`，请使用以下命令：

```bash
yarn add zod
```

如果找到`pnpm-lock.yaml`，请使用以下命令：

```bash
pnpm i zod
```

然后，可以与组件一起定义 Zod 模式：

```tsx title="src/MyComposition.tsx"
import { z } from "zod";

export const MyCompositionSchema = z.object({
  title: z.string(),
});

const MyComponent: React.FC<z.infer<typeof MyCompositionSchema>> = () => {
  return (
    <div>
      <h1>{props.title}</h1>
    </div>
  );
};
```

在根文件中，架构可以传递给组合：

```tsx title="src/Root.tsx"
import { Composition } from "remotion";
import { MycComponent, MyCompositionSchema } from "./MyComposition";

export const RemotionRoot = () => {
  return (
    <Composition
      id="MyComposition"
      component={MyComponent}
      durationInFrames={100}
      fps={30}
      width={1080}
      height={1080}
      defaultProps={{ title: "Hello World" }}
      schema={MyCompositionSchema}
    />
  );
};
```

现在，用户可以在侧边栏中直观地编辑参数。

Zod 支持的所有模式都受 Remotion 支持。

Remotion 要求顶级类型是 z.object()，因为 React 组件的 props 集合始终是一个对象。

## 颜色选择器

要添加颜色选择器，请使用 `@remotion/zod-types` 中的 `zColor()`。

如果未安装，请使用以下命令：

```bash
npx remotion add @remotion/zod-types # If project uses npm
bunx remotion add @remotion/zod-types # If project uses bun
yarn remotion add @remotion/zod-types # If project uses yarn
pnpm exec remotion add @remotion/zod-types # If project uses pnpm
```

然后从`@remotion/zod-types`导入`zColor`：

```tsx
import { zColor } from "@remotion/zod-types";
```

然后在架构中使用它：

```tsx
export const MyCompositionSchema = z.object({
  color: zColor(),
});
```
