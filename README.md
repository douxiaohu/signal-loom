# Telegram 频道资讯平台

**当前正式版：1.0.0**

单机可部署的公开资讯聚合服务。采集公开 Telegram 频道（以及可选的 Bot 群组/频道），提供免密浏览、检索和媒体查看。

技术栈是 **Go + React 19 + SQLite**（服务端已从 Python/FastAPI 迁移到 Go）。默认一个容器、一个进程、一份本地数据库。容器内服务监听 `0.0.0.0:8000`，Compose **只把端口发布到** `127.0.0.1:8000`。公网访问交给同机反向代理或 Tunnel。只能跑一个实例：采集调度和 SQLite 写者都在同一进程里。

| 入口 | 地址 | 访问控制 |
| --- | --- | --- |
| 频道资讯 | `/` | 免密，只展示管理员标记为公开的来源 |
| 管理中心 | `/admin` | 单管理员密钥登录 |
| 健康检查 | `/health` | 免密，返回 `{"status":"ok"}` |

仓库：[https://github.com/douxiaohu/telegram-github-radar](https://github.com/douxiaohu/telegram-github-radar)（私有）。更细的架构说明见 [`docs/architecture/2026-08-13-modular-monolith.md`](docs/architecture/2026-08-13-modular-monolith.md)。

## 现在的结构

进程内部按端口适配器拆开，部署形态不变：

```
浏览器 --HTTPS--> 反向代理 / Tunnel
                      |
              127.0.0.1:8000  (Compose 发布)
                      |
              Go 服务（单进程）
         +------------+------------+
         | HTTP       | Jobs       |
         | /          | 频道采集   |
         | /admin     |            |
         +------+-----+-----+------+
                |           |
         SourceService   FeedService
                |           |
     SourceAdapter     SQLite repositories
     telegram_public   data/telegram_forwarder.db
     telegram_bot      data/media-cache
```

- 新来源实现 `SourceAdapter`（`validate_locator` / `allocate_source_id` / `fetch`）。`fetch()` **只拉数据，不写库**。
- 通知有空的 `Notifier` 端口，本轮没有任何通道。企业微信 / 截图 / 投递 HTTP 已从运行时删除；历史 `delivery_*` 表保留在库里，但不提供界面。
- RSS 等非 Telegram 来源还不入库：`messages.message_id` 仍是整数。下一轮需要 `external_id TEXT` 和管理表单。

## 功能

**公共端**

- 只读浏览公开频道消息：来源、关键词、媒体类型、游标分页
- 图片先加载等比缩略图，点击后再拉原图
- 可跳转 Telegram 原文

**管理端**

- 添加 `telegram_public`（公开频道 URL）或 `telegram_bot`（数字 `chat_id`）来源
- 新来源默认采集、默认不公开
- 启停采集、立即采集、来源健康、消息检索
- 监测规则与命中确认 / 解决

**不会再出现的东西**

- `/status`、`/api/groups`、`/api/deliveries`、`/jobs/forward-now`、`/screenshots`
- 企业微信 Webhook、截图摘要、投递重试

## 运行环境

| 方式 | 要求 |
| --- | --- |
| Docker | Docker Engine 20+、Compose v2、约 1 核 / 1GB 起步 |
| 本地开发 | Python 3.11+、Node.js 20+、npm |
| 生产暴露 | 同机 Caddy / Nginx 或 Cloudflare Tunnel；不要把 `8000` 映射到 `0.0.0.0` |

Linux 把 `APP_UID` / `APP_GID` 设为部署用户的 `id -u` / `id -g`。

## 快速开始（Docker）

```bash
git clone https://github.com/douxiaohu/telegram-github-radar.git
cd telegram-github-radar
cp .env.example .env
cp config/groups.example.yaml config/groups.yaml
```

生成密钥（生产缺少管理密钥、或会话密钥不足 32 字节时会拒绝启动）：

```bash
# 写入 .env
ADMIN_API_KEY=$(openssl rand -hex 24)
SESSION_SECRET=$(openssl rand -hex 32)
```

至少确认：

```bash
DATABASE_URL=sqlite:///./data/telegram_forwarder.db
TIMEZONE=Asia/Shanghai
ADMIN_API_KEY=
SESSION_SECRET=
SESSION_COOKIE_SECURE=true
APP_ENV=production
APP_UID=1000
APP_GID=1000
```

`config/groups.yaml` 只在 **sources 表为空** 时种入一次。公开频道写成 `source: https://t.me/channel`；Bot 来源写成数字 `chat_id`。种入后公开范围和启停都在 `/admin` 维护。

当前 `docker-compose.yml` 接入外部网络 `ai-internal`。新机器先执行：

```bash
docker network create ai-internal
```

不需要和同机其它服务互通时，也可以删掉 compose 里的 `ai-internal` 声明。

```bash
mkdir -p data/media-cache
docker compose up -d --build
curl -sS http://127.0.0.1:8000/health
```

公开频道启动后立刻抓一次，之后按 `CRAWL_INTERVAL_SECONDS`（默认 300）继续。配置了 `TELEGRAM_BOT_TOKEN` 时，才会长轮询 `adapter=telegram_bot` 且已启用的来源。

### HTTPS 反代

Caddy：

```caddy
radar.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:8000
}
```

部署后应满足：HTTPS 根路径免密；`/admin` 才有密钥框；未登录访问 `/api/admin/sources` 返回 401；公网访问裸 `IP:8000` 失败。

对反向代理的要求：

- **保留原始 `Host` 头**（Caddy 默认保留；Nginx 需要 `proxy_set_header Host $host;`）。所有写操作（登录、登出、管理端修改、反馈）都会校验 `Origin` 与 `Host` 同源，`Host` 被改写会得到 403。
- 传递客户端地址：Caddy 默认带 `X-Forwarded-For`；Nginx 需要 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`。服务只信任来自 `TRUSTED_PROXIES`（默认：本机与内网段）的转发头，并取链上最右侧不属于可信代理的地址作为客户端 IP，用于登录限流和访问统计；直连客户端伪造的转发头一律忽略。
- 在 Cloudflare 等 CDN 之后，把 CDN 的出口网段加入 `TRUSTED_PROXIES`，否则看到的是 CDN 地址。

## 本地开发

需要 Go 1.26+、Node.js 20+。

```bash
cp .env.example .env
cp config/groups.example.yaml config/groups.yaml
cd frontend && npm ci && npm run build && cd ..

APP_ENV=development \
HOST=127.0.0.1 \
ADMIN_API_KEY=local-admin-key-1234 \
SESSION_SECRET=local-session-secret-at-least-32-bytes \
SESSION_COOKIE_SECURE=false \
go run ./cmd/server
```

`APP_ENV=development` 下不设 `ADMIN_API_KEY` 时，服务会生成一个仅本次运行有效的随机密钥并打印在日志里；没有任何固定的默认密码。开发环境同样要求密钥至少 16 字符。

```bash
cd frontend
npm run dev
```

Vite 只把 `/api` 代理到后端。本地把 `SESSION_COOKIE_SECURE` 设为 `false`，生产必须为 `true`。

## 添加来源

**公开频道（默认）**

管理中心填写名称和 `https://t.me/channel`，或：

```bash
curl -X POST https://radar.example.com/api/admin/sources \
  -H 'Content-Type: application/json' \
  -d '{"name":"竹新社","source_url":"https://t.me/s/tnews365"}'
```

`source_id` / `chat_id` 由用户名 CRC 映射到 `-900000000000` 空间，与媒体缓存目录算法一致。

**Bot 来源**

机器人必须已在目标群 / 频道内，并配置 `TELEGRAM_BOT_TOKEN`：

```bash
curl -X POST https://radar.example.com/api/admin/sources \
  -H 'Content-Type: application/json' \
  -d '{"name":"内部群","source_url":"-1001234567890","adapter":"telegram_bot"}'
```

Bot 使用真实 Telegram `chat_id`，不再哈希。未公开的 Bot 消息只出现在 `/admin`。

> **Go 版本现状**：只实现了 `telegram_public`。`adapter` 为其它值（含 `telegram_bot`）时返回 422；`groups.yaml` 里的 Bot 条目导入时会被跳过并在日志里提示。

重复添加同一个频道返回 409，不会覆盖已有来源的名称、公开状态或启停。

## 配置

完整示例见 [`.env.example`](.env.example)。不要提交真实 `.env` 或 `config/groups.yaml`。

| 变量 | 说明 |
| --- | --- |
| `APP_ENV` | `production`（默认）/ `staging` / `development` / `test`，不区分大小写；拼写错误会**拒绝启动**，不会退化成宽松模式 |
| `ADMIN_API_KEY` | 管理登录密钥，生产必填且至少 16 字符 |
| `SESSION_SECRET` | 会话 HMAC 密钥，生产至少 32 字节 |
| `SESSION_COOKIE_SECURE` | 生产必须 `true`；接受 `true/false/1/0/yes/no/on/off`，无法识别的值按 `true` 处理 |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_WINDOW_SECONDS` | 每个客户端在窗口内最多失败登录次数（默认 5 次 / 900 秒），超过返回 429 + `Retry-After` |
| `FEEDBACK_RATE_LIMIT` / `FEEDBACK_RATE_WINDOW_SECONDS` | 反馈提交限流（默认 5 次 / 60 秒） |
| `HOST` / `PORT` | 监听地址（默认所有网卡，Docker 内需要）与端口 |
| `TRUSTED_PROXIES` | 可信反向代理，逗号分隔的 IP / CIDR，或 `private`（默认）/ `loopback` / `none` |
| `TIMEZONE` | 规则静默时段与"今日访问"的时区 |
| `MEDIA_ALLOWED_HOSTS` / `MEDIA_MAX_BYTES` | 媒体缓存只下载这些域名（含子域）的 https 资源，单文件上限，默认 `telesco.pe,cdn-telegram.org` / 96 MiB |
| `TELEGRAM_BOT_TOKEN` | Go 版本不使用（Bot 适配器未迁移），保留只为兼容旧 `.env` |
| `CRAWL_INTERVAL_SECONDS` | 公开频道采集间隔 |

数据库文件名保持 `data/telegram_forwarder.db`，不要改路径除非你同时改备份脚本。

## 可见性合同（不要改）

- 公共：请求的 `chat_id` 不在公开白名单 → **404**，不是空页
- 公共：未指定来源且没有公开源 → **200** + 空列表
- 管理：列表**不加** `IN (sources.id)`。历史孤儿 `chat_id` 仍能在管理端看到
- 公共媒体：缺失与未公开一律 **404**
- 会话：`tg_session`，HttpOnly，SameSite=Strict，Path=/，登出后 token 立即作废（进程内 sid 表，重启需重新登录）
- 媒体：公开端 `/api/public/media/*` 只服务启用且已公开来源的消息；管理端使用需要会话的 `/api/admin/media/*`。服务器只下载白名单 CDN 上的 https 资源，且有大小上限
- 写操作：所有 `POST/PATCH/PUT/DELETE /api/*` 必须带与 `Host` 同源的 `Origin`，请求体必须是 `application/json` 且有大小上限

## 备份与升级

```bash
mkdir -p backups
cp data/telegram_forwarder.db "backups/telegram-forwarder-$(date +%Y%m%d-%H%M%S).db"
tar -czf "backups/data-$(date +%Y%m%d-%H%M%S).tgz" data/
git pull
docker compose up -d --build
```

schema 只做增量 `ALTER`。已有消息、历史 `delivery_*` 和 GitHub 行不会被删除。

## 验证

```bash
.venv/bin/python -m unittest discover -s tests -v
cd frontend
npm run test
npm run build
```

部署后确认调度器只注册 `crawl_public_sources`，`/github` 和 `/api/public/github/rankings` 返回 404。

## 项目布局

```
app/
  main.py                 装配：AppContext、路由、静态资源
  context.py              进程内依赖
  domain/                 用例：来源、资讯流
  ingest/                 SourceAdapter：telegram_public / telegram_bot
  persistence/sqlite/     连接（busy_timeout=5000）与存储
  jobs/                   JobSpec / JobRunner
  notifications/          空 Notifier 端口
  http/                   错误脱敏等 HTTP 辅助
  security.py             会话 HMAC + sid 表
frontend/src/
  features/               公共资讯 / 管理入口
config/groups.example.yaml
docs/architecture/        模块化单体设计
```

## 以后怎么加功能

| 要加的东西 | 怎么加 | 不要做 |
| --- | --- | --- |
| 另一种 Telegram 抓取 | 新 `SourceAdapter`，注册进 `AdapterRegistry` | 改 `SQLiteStorage.create_source` 写死类型 |
| RSS | 先做 `external_id TEXT` 和表单，再写 adapter | 把 GUID 硬塞进整数 `message_id` |
| 邮件 / Webhook | 实现 `Notifier` 并挂到 `NotificationService` | 复活 WeCom `Forwarder` |
| Postgres / 独立采集进程 | 换 repository；先把会话 sid 落库 | 直接把 uvicorn workers 调到 >1 |

## 许可

本仓库当前为私有仓库。对外分发前请自行补充许可证。
