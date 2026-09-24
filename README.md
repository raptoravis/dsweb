# dsweb

多用户对话面板：浏览器 frontend（对话列表 + 消息流 + 可折叠 agent 轨迹）→ backend（鉴权 + 账号 + 会话路由）→ deepseek-harness（dsh）作为 agent 引擎。每个用户一个独立 harness home 与 dsh 进程，按活跃惰性拉起、空闲回收。

## 结构

```
backend/    TypeScript / Node — REST + SSE，SQLite 持久化，dsh adapter（Seam 2）
frontend/   React + TypeScript + Vite — 对话面板，CSS 变量主题 token
docs/       领域词汇（CONTEXT.md）、ADR
```

## 运行

```bash
npm install                      # 根目录一次性安装两个 workspace

# backend（无真实 dsh / key 时用 fake adapter）
cd backend && npm run dev        # 默认 3001 端口；无 DEEPSEEK_API_KEY 时自动用 fake

# frontend（开发服务器，/api 代理到 3001）
cd frontend && npm run dev
```

浏览器打开 Vite 输出的地址（默认 http://localhost:5173）即可注册、登录、对话。

要使用真实 dsh，在 `backend/.env` 中设置 `DEEPSEEK_API_KEY=...`，然后启动或重启 backend。该文件已被 Git 忽略；已有的进程环境变量优先。未设置 key 时继续使用 fake adapter。

## 环境变量（backend）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3001` | 监听端口 |
| `DSWEB_DB` | `./dsweb.db` | SQLite 文件路径 |
| `DEEPSEEK_API_KEY` | 无 | 管理员统一注入各 harness home 的 DeepSeek key（仅入子进程 env，不入代码/日志） |
| `DSH_BIN` | `dsh` | dsh 可执行文件 |
| `DSH_PROVIDER` | `deepseek-official` | dsh 模型路由 |
| `DSH_MODEL` | `deepseek-flash` | 模型 id |
| `DSH_IDLE_TIMEOUT_MS` | `1800000` | 空闲回收阈值 |
| `DSH_MAX_CONCURRENT` | `64` | 并发 dsh 进程上限 |
| `DSH_ADAPTER` | — | 置 `fake` 强制使用内存 fake adapter |

## 测试

```bash
npm test                         # backend 集成测试（注入 fake adapter，经 Seam 1 HTTP API）
npm run typecheck                # 两个 workspace 的类型检查
```

真 dsh 冒烟测试单独加 tag，仅在专用环境跑：

```bash
cd backend && DSH_SMOKE=1 DEEPSEEK_API_KEY=... npm run test
```

## 与 ADR-0001 的一处偏差

ADR-0001 设想「对话消息与 agent 轨迹历史落在 dsh 的 session 日志，backend 经 adapter 的 `history` 接口读取」。实现时发现 dsh SDK 的 stdio JSON-RPC 只暴露 `initialize` / `session/prompt` / `shutdown`，**没有读取历史的方法**；直接解析 dsh 内部 session 日志格式会耦合其 developer-preview 内部结构，恰与 ADR「SDK 封装层隔离升级风险」的目标相悖。因此 v1 把消息与轨迹历史持久化在 backend 自己的 `messages` 表，adapter 只负责驱动（prompt/follow/close）；dsh 的 harness home 仍保留其自身日志用于内部 resume。代价是 backend 多存一份历史，换取历史读取对 dsh 完全解耦、进程回收后仍可读。
