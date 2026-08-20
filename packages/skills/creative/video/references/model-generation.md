# Video Gen

两个后端，各自独立脚本，成功都打印 `{"ok":true,"paths":[...]}`，失败打印 `{"ok":false,"error":...}` 且退出码 1。

## Grok（默认，订阅内免费）

需要本机 `grok` CLI 已登录。参数全部用自然语言写进 prompt：比例（`9:16 竖版`）、时长（`6秒`）、音频（`带环境音`）、风格。

```bash
python3 ../scripts/grok_video.py \
  "VIDEO_PROMPT" --out "/absolute/path/output.mp4"
```

生成约 1-3 分钟，默认超时 900s（`--timeout` 可调，调用方 bash timeout 必须更大）。多镜头输出 `output-1.mp4` 等。多条视频串行生成，不要并发。

## Seedance（API 按量付费，用户明确要求时用）

需要 `~/.config/video-gen/seedance.json`（`{"url":...,"key":...}`）。参数用 flag 传：

```bash
python3 ../scripts/seedance_video.py \
  "VIDEO_PROMPT" --out "/absolute/path/output.mp4" \
  --duration 5 --resolution 480p --ratio 9:16
```

- `--model`：`seedance-2.0-mini`（最便宜，默认）/ `seedance-2.0-fast` / `seedance-2.0`
- `--duration`：4-15 秒整数，默认 5
- `--resolution`：`480p`（默认，最省）/ `720p` / `1080p`
- `--ratio`：`16:9`（默认）/ `9:16` / `1:1` / `adaptive`
- `--no-audio`：默认带 AI 配音/音效，加此 flag 省掉
- `--first-frame` / `--last-frame`：首/尾帧图片（本地路径或 URL，尾帧需搭配首帧）
- `--ref`：参考图，可重复最多 9 张；与首尾帧互斥（网关限制）
- 按量计费：默认 mini + 480p + 5 秒已是最省组合，用户要求高质量再升 `--resolution 720p` 或换模型

长 prompt 两个脚本都可 pipe stdin。
