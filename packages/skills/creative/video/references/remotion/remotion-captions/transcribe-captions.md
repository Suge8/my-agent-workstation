---
name: transcribe-captions
description: 转录音频以生成 Remotion 中的字幕
metadata:
  tags: captions, transcribe, whisper, audio, speech-to-text
---

# 转录音频

要转录音频以生成 Remotion 中的字幕，您可以使用 [`@remotion/install-whisper-cpp`](https://www.remotion.dev/docs/install-whisper-cpp) 包中的 [`transcribe()`](https://www.remotion.dev/docs/install-whisper-cpp/transcribe) 函数。

## 先决条件

首先，需要安装@remotion/install-whisper-cpp包。
如果未安装，请使用以下命令：

```bash
npx remotion add @remotion/install-whisper-cpp
```

## 抄写

制作一个Node.js脚本来下载Whisper.cpp和模型，并转录音频。

```ts
import path from "path";
import {
  downloadWhisperModel,
  installWhisperCpp,
  transcribe,
  toCaptions,
} from "@remotion/install-whisper-cpp";
import fs from "fs";

const to = path.join(process.cwd(), "whisper.cpp");

await installWhisperCpp({
  to,
  version: "1.5.5",
});

await downloadWhisperModel({
  model: "medium.en",
  folder: to,
});

// Convert the audio to a 16KHz wav file first if needed:
// import {execSync} from 'child_process';
// execSync('ffmpeg -i /path/to/audio.mp4 -ar 16000 /path/to/audio.wav -y');

const whisperCppOutput = await transcribe({
  model: "medium.en",
  whisperPath: to,
  whisperCppVersion: "1.5.5",
  inputPath: "/path/to/audio123.wav",
  tokenLevelTimestamps: true,
});

// Optional: Apply our recommended postprocessing
const { captions } = toCaptions({
  whisperCppOutput,
});

// Write it to the public/ folder so it can be fetched from Remotion
fs.writeFileSync("captions123.json", JSON.stringify(captions, null, 2));
```

单独转录每个剪辑并创建多个 JSON 文件。

如何显示Remotion中的字幕，请参见[显示字幕](display-captions.md)。
