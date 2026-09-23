# 每个用户一个 dsh 进程，backend 通过 SDK 驱动 deepseek-harness

dsweb 是一个多用户 web 应用，架构为三层：浏览器 frontend（对话面板）→ 我们的 backend（鉴权 + 账号 + 会话路由）→ deepseek-harness（dsh）作为 agent 引擎。dsh 是单机单 operator 的 agent 运行时，没有多用户/租户概念，隔离单位是 harness home（`$DSH_HOME`）；`dsh web --host 0.0.0.0` 被显式拒绝，HTTP `/api` 层没有 token 认证。因此 backend 用官方 JSON-RPC-over-stdio SDK（`dsh --profile sdk` 起子进程）驱动 dsh：每个用户一个独立 harness home，按活跃惰性拉起进程、退出/长时间空闲即回收、再次使用重拉；多用户鉴权与隔离由我们的 backend 自行实现。

## Considered Options

- **把 frontend 做成 dsh 内的 Cordis 插件**（占 fallback 席位 / 注入 Slots）：被否——插件活在 dsh 单机 Web UI 内，与「多用户、完全隔离」矛盾。
- **frontend 直接打 dsh 的 `/api` RPC**：被否——信任栅栏只放行本机 + 浏览器 cookie，`--host 0.0.0.0` 不支持，无法服务多用户。
- **backend 用 SDK 包 dsh**（选定）：唯一同时满足多用户、完全隔离、暴露 agent 能力（流式事件 trace）的路径。

## Consequences

- 每活跃用户 = 一个 dsh 进程 + 一个独立 harness home；并发活跃约几十 → 进程池规模几十。
- 对话历史持久化在各自 harness home 的 session 日志；backend 只存账号 + 对话元数据（标题/id/时间）。
- 模型凭据由管理员统一配一个 DeepSeek key，注入各 harness home。
- dsh 处于 developer preview，接口可能 breaking change——SDK 封装层用于隔离升级风险。
