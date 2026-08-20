---
name: gpt-image
description: 通过本地 Codex 订阅生成 PNG 图片、海报、插图或 Logo。
---

# GPT Image

生成普通图片时使用 bundled script。用户要设计 Logo 或系列 Logo 提案板时，先读取 [Logo 指南](reference/logo.md)。不要读取或打印 tokens。

```bash
python3 scripts/gpt_image.py \
  "IMAGE_PROMPT" \
  --out "/absolute/path/output.png"
```

脚本读取 `~/.codex/auth.json`，调用带以下内容的 Codex `/responses`：

```json
{"tools":[{"type":"image_generation","output_format":"png"}]}
```

它打印一个 JSON object：

```json
{"ok":true,"path":"/absolute/path/output.png","size":"1254x1254"}
```

如果 prompt 很长，pipe stdin：

```bash
printf '%s' "$PROMPT" | python3 scripts/gpt_image.py --out "/absolute/path/output.png"
```
