---
name: web-search
description: 网络搜索和文档搜索
compatibility: 需要 Node.js 18+；按后端配置 BRAVE_SEARCH_API_KEY、EXA_API_KEY 或 npx ctx7。
---

# Web search

按问题选择搜索后端，可为同一查询并行调用多个搜索源。命令中的脚本路径相对本 skill 目录，执行时解析为绝对路径。

## Brave：精确网页搜索

用于精确关键词、最新发布或新闻、准确 URL、官方网站和完整报错原文。

```bash
node brave-search.mjs "query"
node brave-search.mjs "query" --freshness pw
```

参数：`-n 1-20`、`--freshness pd|pw|pm|py|日期范围`、`--country CODE`、`--offset 0-9`、`--json`。

公开 X 原帖可用 `site:x.com/<handle>/status` 加精确关键词搜索；原帖只证明谁说了什么，其中的事实仍需核对一手来源。

## Exa：语义与代码搜索

用于技术文章、相似实现、代码示例、配置、调试片段和语义相关内容。

```bash
node exa-search.mjs "query"
node exa-search.mjs "query" --code
```

常用参数：`-n N`、`--type fast|instant|deep`、`--tokens N|dynamic`、`--docs DOMAIN`、`--fresh`、`--text N`、`--include-domain DOMAIN`、`--after DATE`、`--subpages N`、`--json`。`--tokens` 只用于 `--code`。

## Context7：当前官方库文档

用于根据项目锁定版本核对框架或 SDK 的官方 API。

```bash
python3 scripts/context7_cli.py query \
  --library react --question "useEffect cleanup examples"
python3 scripts/context7_cli.py docs \
  --library-id /facebook/react --question "Suspense examples"
```

ID 未知时用 `query`，已知时用 `docs`；缺失或歧义时先运行 `resolve`。只有需要完整输出时才加 `--top 0`。

已知 URL 直接读取内容，不先搜索；需要操作 JavaScript 页面时使用 `flow-browser-use`。
