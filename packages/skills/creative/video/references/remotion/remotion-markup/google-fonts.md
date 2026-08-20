---
name: fonts
description: 加载Google Fonts和Remotion中的本地字体
metadata:
  tags: fonts, google-fonts, typography, text
---

# 使用Remotion中的字体

## Google Fonts 与 @remotion/google-fonts

推荐使用Google Fonts的方式。它是类型安全的，并且会自动阻止渲染，直到字体准备好为止。

### 先决条件

首先，需要安装@remotion/google-fonts包。
如果未安装，请使用以下命令：

```bash
npx remotion add @remotion/google-fonts # If project uses npm
bunx remotion add @remotion/google-fonts # If project uses bun
yarn remotion add @remotion/google-fonts # If project uses yarn
pnpm exec remotion add @remotion/google-fonts # If project uses pnpm
```

```tsx
import { loadFont } from "@remotion/google-fonts/Lobster";

const { fontFamily } = loadFont();

export const MyComposition = () => {
  return <div style={{ fontFamily }}>Hello World</div>;
};
```

最好仅指定所需的权重和子集以减少文件大小：

```tsx
import { loadFont } from "@remotion/google-fonts/Roboto";

const { fontFamily } = loadFont("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});
```

## 在组件中使用

在组件的顶层或在早期导入的单独文件中调用 `loadFont()`：

```tsx
import { loadFont } from "@remotion/google-fonts/Montserrat";

const { fontFamily } = loadFont("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

export const Title: React.FC<{ text: string }> = ({ text }) => {
  return (
    <h1
      style={{
        fontFamily,
        fontSize: 80,
        fontWeight: "bold",
      }}
    >
      {text}
    </h1>
  );
};
```
