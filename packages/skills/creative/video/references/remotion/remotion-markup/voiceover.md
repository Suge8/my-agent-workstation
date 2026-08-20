---
name: voiceover
description: 使用 TTS 将 AI 生成的画外音添加到 Remotion 作品中
metadata:
  tags: voiceover, audio, elevenlabs, tts, speech, calculateMetadata, dynamic duration
---

# 将 AI 配音添加到 Remotion 作品中

使用 ElevenLabs TTS 生成每个场景的语音音频，然后使用 [`calculateMetadata`](./calculate-metadata.md) 动态调整合成大小以匹配音频。

## 先决条件

默认情况下，本指南使用 **ElevenLabs** 作为 TTS 提供程序（`ELEVENLABS_API_KEY` 环境变量）。用户可以替换任何可以生成音频文件的TTS服务。

如果用户未指定 TTS 提供商，则推荐 ElevenLabs 并询问其 API 密钥。

确保运行生成脚本时环境变量可用：

```bash
node --strip-types generate-voiceover.ts
```

## 使用 ElevenLabs 生成音频

创建一个脚本来读取配置，为每个场景调用 ElevenLabs API，并将 MP3 文件写入 `public/` 目录，以便 Remotion 可以通过 `staticFile()` 访问它们。

单个场景的核心API调用：

```ts title="generate-voiceover.ts"
const response = await fetch(
  `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
  {
    method: "POST",
    headers: {
      "xi-api-key": process.env.ELEVENLABS_API_KEY!,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text: "Welcome to the show.",
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.3,
      },
    }),
  },
);

const audioBuffer = Buffer.from(await response.arrayBuffer());
writeFileSync(`public/voiceover/${compositionId}/${scene.id}.mp3`, audioBuffer);
```

## 使用计算元数据动态合成持续时间

使用[`calculateMetadata`](./calculate-metadata.md)测量[音频持续时间](../mediabunny/get-audio-duration.md)并相应地设置合成长度。

```tsx
import { CalculateMetadataFunction, staticFile } from "remotion";
import { getAudioDuration } from "./get-audio-duration";

const FPS = 30;

const SCENE_AUDIO_FILES = [
  "voiceover/my-comp/scene-01-intro.mp3",
  "voiceover/my-comp/scene-02-main.mp3",
  "voiceover/my-comp/scene-03-outro.mp3",
];

export const calculateMetadata: CalculateMetadataFunction<Props> = async ({
  props,
}) => {
  const durations = await Promise.all(
    SCENE_AUDIO_FILES.map((file) => getAudioDuration(staticFile(file))),
  );

  const sceneDurations = durations.map((durationInSeconds) => {
    return durationInSeconds * FPS;
  });

  return {
    durationInFrames: Math.ceil(sceneDurations.reduce((sum, d) => sum + d, 0)),
  };
};
```

计算出的 `sceneDurations` 通过 `voiceover` 属性传递到组件中，以便组件知道每个场景应该有多长。

如果合成使用 [`<TransitionSeries>`](./transitions.md)，则从总持续时间中减去重叠：[./transitions.md#calculate-total-composition-duration](./transitions.md#calculating-total-composition-duration)

## 在组件中渲染音频

有关如何在组件中渲染音频的更多信息，请参阅 [audio.md](./audio.md)。

## 延迟音频开始

有关如何延迟音频开始的更多信息，请参阅 [audio.md#delaying](./audio.md#delaying)。
