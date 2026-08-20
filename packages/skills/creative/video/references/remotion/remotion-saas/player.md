---
name: player
description: 使用 @remotion/player. 在 React 应用程序中嵌入 Remotion 预览
metadata:
  tags: remotion, player, preview, react
---

当用户想要在 React 中进行交互式预览时，请使用 `@remotion/player`。

```tsx
import {Player} from '@remotion/player';
import {MyVideo} from './remotion/MyVideo';

export const App: React.FC = () => {
  return (
    <Player
      component={MyVideo}
      durationInFrames={120}
      compositionWidth={1920}
      compositionHeight={1080}
      fps={30}
      controls
    />
  );
};
```

如果元数据是动态的，请手动同步 Player 道具或重用合成的 `calculateMetadata()` 逻辑。
链接https://www.remotion.dev/docs/dynamic-metadata.md#with-the-player.

玩家的完整API：https://www.remotion.dev/docs/player/player.md.

对于也需要输出文件的 SaaS 应用程序，请将播放器预览与 [framework.md](framework.md) 或 [rendering.md](rendering.md) 结合起来。
