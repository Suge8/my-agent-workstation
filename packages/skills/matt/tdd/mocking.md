# 何时使用 Mock

只在**系统边界**处使用 Mock：

- 外部 API（支付、电子邮件等）
- 数据库（有时——优先使用测试数据库）
- 时间/随机性
- 文件系统（有时）

不要 Mock：

- 你自己的类/模块
- 内部协作者
- 任何由你控制的内容

## 设计可 Mock 性

在系统边界处，设计易于 Mock 的接口：

**1. 使用依赖注入**

传入外部依赖，而不是在内部创建它们：

```typescript
// Easy to mock
function processPayment(order, paymentClient) {
  return paymentClient.charge(order.total);
}

// Hard to mock
function processPayment(order) {
  const client = new StripeClient(process.env.STRIPE_KEY);
  return client.charge(order.total);
}
```

**2. 优先使用 SDK 风格的接口，而不是通用 fetcher**

为每个外部操作创建具体函数，而不是使用带条件逻辑的通用函数：

```typescript
// GOOD: Each function is independently mockable
const api = {
  getUser: (id) => fetch(`/users/${id}`),
  getOrders: (userId) => fetch(`/users/${userId}/orders`),
  createOrder: (data) => fetch('/orders', { method: 'POST', body: data }),
};

// BAD: Mocking requires conditional logic inside the mock
const api = {
  fetch: (endpoint, options) => fetch(endpoint, options),
};
```

SDK 方式意味着：
- 每个 Mock 返回一种特定形状
- 测试设置中没有条件逻辑
- 更容易看出测试执行了哪些端点
- 每个端点都有类型安全
