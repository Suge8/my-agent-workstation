---
name: ffmpeg
description: 在 Remotion 中使用 FFmpeg 和 FFprobe
metadata:
  tags: ffmpeg, ffprobe, video, trimming
---

## Remotion 中的FFmpeg

`ffmpeg`和`ffprobe`不需要安装。它们可通过 `npx remotion ffmpeg` 和 `npx remotion ffprobe` 获得：

```bash
npx remotion ffmpeg -i input.mp4 output.mp3
npx remotion ffprobe input.mp4
```

### 修剪视频

您有 2 个剪辑视频选项：

1. **首选**：使用`<Video>`组件的`trimBefore`和`trimAfter`道具。这是非破坏性的，不需要重新编码，并且您可以随时更改修剪。

```tsx
import {Video} from '@remotion/media';

<Video src={staticFile('video.mp4')} trimBefore={5 * fps} trimAfter={10 * fps} />;
```

2. 使用 FFmpeg 命令行。您MUST重新编码视频以避免视频开始时出现冻结帧。仅当您需要独立的修剪文件（例如用于上传或外部使用）时才使用此选项。

```bash
# Re-encodes from the exact frame
npx remotion ffmpeg -ss 00:00:05 -i public/input.mp4 -to 00:00:10 -c:v libx264 -c:a aac public/output.mp4
```
