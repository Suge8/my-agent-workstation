# bcu 错误恢复

此表由 `src/errors.ts` 的 `ERROR_DEFINITIONS` 生成。失败时 stdout 为空，stderr 给出 `error CODE` 和 `recovery`；不要把非零退出码当成功。

| 错误码 | exit | 恢复动作 |
|---|---:|---|
| `invalid_arguments` | 2 | 运行 `bcu --help`，修正参数。不要原样重试。 |
| `stale_state` | 3 | 重新运行 `observe-ui`，使用新的 `stateId` 和 ref 重试。 |
| `permission_missing` | 4 | 在交互式终端运行 `bcu setup`，授予两项权限后重试。 |
| `app_not_found` | 5 | 打开应用，再运行 `bcu find-roots` 确认当前名称。 |
| `window_stale` | 6 | 运行 `bcu find-roots`，观察当前根后重试。 |
| `element_not_found` | 7 | 重新运行 `observe-ui`，使用新状态返回的 `@e` ref。 |
| `action_timeout` | 8 | 检查当前 UI；修正等待条件，或使用合理的更长 `--timeout`。 |
| `action_failed` | 9 | 先观察当前 UI，再判断动作是否适合安全重试。 |
| `broker_unavailable` | 10 | 运行 `bcu doctor`；若仍有陈旧进程，运行 `bcu stop` 后重试。 |
| `helper_unavailable` | 11 | 运行 `bcu doctor`，按报告修复 helper 后重试。 |
| `browser_unavailable` | 12 | 安装目标浏览器，或运行 `bcu browser launch --browser helium`。 |
| `unsupported_platform` | 13 | 在受支持的 macOS 或 Windows 交互式桌面会话中使用 bcu。 |
| `state_too_large` | 14 | 观察更小的根，或先缩小 UI 范围再重试。 |
| `internal_error` | 1 | 运行 `bcu doctor` 后重试；若重复，报告完整错误。 |

## 恢复纪律

- `stale_state`、`window_stale`、`element_not_found` 都要求取新状态；不要把旧 ref 拼到新 `stateId`。
- `action_timeout` 不等于动作没发生。先观察当前 UI，避免重复提交、发送或删除。
- `action_failed` 可能代表 `didnt`、`unknown` 或后置条件失败。读取完整错误和当前状态后再决定。
- 权限错误只运行 `bcu setup`；不要绕过系统权限或改用坐标掩盖失败。
