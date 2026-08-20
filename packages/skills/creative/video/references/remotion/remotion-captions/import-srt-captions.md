---
name: import-srt-captions
description: 使用@remotion/captions将.srt字幕文件导入Remotion
metadata:
  tags: captions, subtitles, srt, import, parse
---

# 将 .srt 字幕导入到 Remotion

如果您有现有的 `.srt` 字幕文件，您可以使用 `@remotion/captions` 中的 `parseSrt()` 将其导入到 Remotion 中。

如果您没有 .srt 文件，请阅读[转录音频](transcribe-captions.md) 了解如何生成字幕。

## 先决条件

首先，需要安装@remotion/captions包。
如果未安装，请使用以下命令：

```bash
npx remotion add @remotion/captions # If project uses npm
bunx remotion add @remotion/captions # If project uses bun
yarn remotion add @remotion/captions # If project uses yarn
pnpm exec remotion add @remotion/captions # If project uses pnpm
```

## 读取 .srt 文件

使用 `staticFile()` 引用 `public` 文件夹中的 `.srt` 文件，然后获取并解析它：

```tsx
import { useState, useEffect, useCallback } from "react";
import { AbsoluteFill, staticFile, useDelayRender } from "remotion";
import { parseSrt } from "@remotion/captions";
import type { Caption } from "@remotion/captions";

export const MyComponent: React.FC = () => {
  const [captions, setCaptions] = useState<Caption[] | null>(null);
  const { delayRender, continueRender, cancelRender } = useDelayRender();
  const [handle] = useState(() => delayRender());

  const fetchCaptions = useCallback(async () => {
    try {
      const response = await fetch(staticFile("subtitles.srt"));
      const text = await response.text();
      const { captions: parsed } = parseSrt({ input: text });
      setCaptions(parsed);
      continueRender(handle);
    } catch (e) {
      cancelRender(e);
    }
  }, [continueRender, cancelRender, handle]);

  useEffect(() => {
    fetchCaptions();
  }, [fetchCaptions]);

  if (!captions) {
    return null;
  }

  return <AbsoluteFill>{/* Use captions here */}</AbsoluteFill>;
};
```

还支持远程 URL - 您可以通过 URL `fetch()` 远程文件，而不是使用 `staticFile()`。

## 使用导入的字幕

解析后，字幕采用 `Caption` 格式，可与所有 `@remotion/captions` 实用程序一起使用。
