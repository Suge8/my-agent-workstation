---
name: silence-detection
description: 使用 FFmpeg Loudnorm 和 SilenceDetect 对 video/audio 文件进行自适应静音检测
metadata:
  tags: silence, detection, trimming, ffmpeg, loudnorm, audio
---

# 自适应静音检测

检测视频或音频文件中的无声片段。

需要 FFmpeg — 请参阅 [ffmpeg.md](./ffmpeg.md) 了解如何在 Remotion 项目中调用它。

## 步骤 1：使用 `loudnorm` 测量响度

在 JSON 模式下使用 `loudnorm` 滤波器来获取每个文件的 EBU R128 集成响度和选通阈值：

```bash
npx remotion ffmpeg -i public/video.mov -map 0:a -af loudnorm=print_format=json -f null /dev/null
```

作为输出，您将得到：
- `input_i`：综合响度 (dB) — 整体感知音量
- `input_thresh`: EBU R128 选通阈值 (dB) — 低于该级别的音频被认为太安静而无法计入响度测量

## 步骤 2：使用自适应阈值检测沉默

将步骤 1 中的 `input_thresh` 值作为 `noise` 参数传递给 `silencedetect`：

```bash
npx remotion ffmpeg -i public/video.mov -map 0:a -af "silencedetect=noise=${THRESH}dB:d=0.5" -f null /dev/null
```

参数：
- `noise`：阈值，低于该阈值音频被视为静音。使用步骤 1 中的 `input_thresh`。
- `d`：最短静音持续时间（以秒为单位）。 `0.5` 是一个很好的默认值。

## 解释输出

过滤器输出 `silence_start` 和 `silence_end` 时间戳对：

```
[silencedetect] silence_start: 0
[silencedetect] silence_end: 2.241021 | silence_duration: 2.241021
[silencedetect] silence_start: 38.77425
[silencedetect] silence_end: 39.619604 | silence_duration: 0.845354
```

## 识别前导沉默和尾随沉默

- **前导静音**：从 0 或接近 0 开始的连续静音段。如果第一个 `silence_start` > 0.5 秒，则没有前导静音。
- **尾随静音**：延伸到（或接近）文件末尾的最后一个静音段。将最后一个`silence_end`与文件的总持续时间进行比较。

当多个静音在开始或结束时几乎连续（间隙 < 0.2 秒）时，将它们视为单个 leading/trailing 静音块。

## 与 Remotion 的 `<Video>` 组件一起使用

使用 `trimBefore` 和 `trimAfter` 应用检测到的修剪点（值以帧为单位）：

```tsx
import { Video } from "@remotion/media";
import { staticFile, useVideoConfig } from "remotion";

const { fps } = useVideoConfig();

<Video
  src={staticFile("video.mov")}
  trimBefore={Math.floor(leadingEnd * fps)}
  trimAfter={Math.ceil(trailingStart * fps)}
/>
```
