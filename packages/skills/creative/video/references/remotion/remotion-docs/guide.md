# Remotion 文档

搜索并获取 Remotion 文档页面

这项技能教您如何发现和阅读当前的 Remotion 文档。
如果这不相关，请改为加载 [Remotion 最佳实践](../../../SKILL.md)。

## 搜索文档

使用 Algolia 搜索 API 查找相关文档页面：

```
POST https://<ALGOLIA_APP_ID>-dsn.algolia.net/1/indexes/*/queries?x-algolia-api-key=<ALGOLIA_API_KEY>&x-algolia-application-id=<ALGOLIA_APP_ID>
Content-Type: application/x-www-form-urlencoded

{
  "requests": [
    {
      "query": "<your search query>",
      "indexName": "remotion",
      "params": "attributesToRetrieve=[\"hierarchy.lvl0\",\"hierarchy.lvl1\",\"hierarchy.lvl2\",\"url\"]&hitsPerPage=10"
    }
  ]
}
```

每个命中都包含一个指向文档页面的 `url` 字段。

## 以 Markdown 形式获取页面

将 `.md` 附加到任何 Remotion 文档 URL 以检索其 Markdown 源（保存标记）：

```
https://www.remotion.dev/docs/use-video-config.md
https://www.remotion.dev/docs/sequence.md
https://www.remotion.dev/docs/lambda/rendermediaonlambda.md
```

## 工作流程

1. 搜索 Algolia 查找您需要的概念或 API。
2. 从结果中选择最相关的URL。
3. 获取每个带有 `.md` 后缀的 URL。
4. 使用当前文档而不是记住的API知识来实现​​。
