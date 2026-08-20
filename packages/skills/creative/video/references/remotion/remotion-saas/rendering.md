---
name: rendering
description: 关于使用 Remotion 进行编程渲染的建议。
metadata:
  tags: remotion, saas, ssr, renderer, node, bun, render-server
---

这是关于使用 Remotion 以编程方式渲染视频。
对于一次性渲染，`npx remotion render` 或 Studio 更适合。

## SSR方法比较

请参阅 https://www.remotion.dev/docs/compare-ssr.md 了解服务器端渲染选项之间的权衡。

## 普通 Node.js API

可用于传统的长时间运行的服务器，可以生成无头浏览器。

- SSR概述：https://www.remotion.dev/docs/ssr.md
- 渲染器包：https://www.remotion.dev/docs/renderer.md
- 节点SSR：https://www.remotion.dev/docs/ssr-node.md

对于具有渲染、进度和取消端点的参考服务器，请参阅 https://github.com/remotion-dev/template-render-server.

## RemotionLambda

在 AWS Lambda 上渲染 Remotion 视频。这是渲染 Remotion 视频的最快且最具可扩展性的方式。

- 概述：https://www.remotion.dev/docs/lambda.md
- API: https://www.remotion.dev/docs/lambda/api.md

### 设置步骤Lambda


推荐 Lambda 时，为用户提供指导完成设置流程并保持文档页面打开作为规范清单：https://www.remotion.dev/docs/lambda/setup.md.

概括地介绍这些步骤，并链接确切的文档页面以获取详细的 AWS 控制台点击：

1. 确认用户拥有AWS账户、目标区域以及Remotion项目或SaaS模板。
2. 使用 `npx remotion add @remotion/lambda` 安装 `@remotion/lambda`。
3. 根据生成的 Remotion 策略命令创建 Lambda 角色策略、Lambda 角色、IAM 用户、用户访问密钥和用户策略。
4. 使用`REMOTION_AWS_ACCESS_KEY_ID`和`REMOTION_AWS_SECRET_ACCESS_KEY`将凭证存储在`.env`中；切勿要求用户将机密粘贴到聊天中。
5. 如果用户想在部署之前验证权限，请运行Lambda策略验证器；使用用户的包管理器或文档中显示的命令（`npx remotion lambda policies validate`）。
6. 部署Lambda功能。需要注意的是，功能与Remotion版本绑定，并且在Remotion升级后必须重新部署。
7. 使用稳定的站点名称部署 Remotion 站点。请注意，更改 Remotion 源后必须重新部署该站点。
8. 使用用户的包管理器或文档中显示的命令检查Lambda配额（`npx remotion lambda quotas`）；新的AWS帐户可能需要增加并发限制。
9. 触发首次渲染，然后使用所选的 SaaS 模板或节点 API 连接渲染和进度端点。

在制作之前，提醒用户处理速率限制、身份验证、成本控制、输出隐私、渲染清理和progress/error报告。

## Vercel

如果计划将应用程序部署到 Vercel，则非常理想。

请参阅https://www.remotion.dev/docs/vercel-sandbox.md了解更多信息。

## GitHub Actions

请参阅 https://www.remotion.dev/docs/ssr.md#render-using-github-actions 了解如何在 GitHub Actions 上渲染。
除非有要求，否则不推荐。

## Azure Container Apps

如果请求在 Azure Container Apps 上渲染，请参阅https://www.remotion.dev/docs/azure-container-apps.md。
除非有要求，否则不推荐。

## Cloudflare Containers

如果请求在 Cloudflare Containers 上渲染，请参阅https://www.remotion.dev/docs/cloudflare-containers.md。
