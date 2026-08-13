# Telegram 资讯与 GitHub 趋势平台

单机可部署的公开资讯聚合服务。采集公开 Telegram 频道（以及可选的 Bot 群组/频道），提供免密浏览、检索和媒体查看；同时定期抓取 GitHub 仓库活跃数据，生成日榜、周榜、月榜。

技术栈是 **Python 3.11 + FastAPI + React 19 + SQLite**。默认一个容器、一个进程、一份本地数据库。容器内 uvicorn 绑定 `0.0.0.0:8000`，Compose **只把端口发布到** `127.0.0.1:8000`。公网访问交给同机反向代理或 Tunnel。必须保持 `--workers 1`：采集调度和 SQLite 写者都在同一进程里。

| 入口 | 地址 | 访问控制 |
| --- | --- | --- |
| 频道资讯 | `/` | 免密，只展示管理员标记为公开的来源 |
| GitHub 趋势 | `/github` | 免密 |
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
              uvicorn --workers 1
         +------------+------------+
         | HTTP       | Jobs       |
         | / /github  | 采集/刷新  |
         | /admin     |            |
         +------+-----+-----+------+
                |           |
         SourceService   FeedService
         GitHubInsightProduct
                |           |
     SourceAdapter     SQLite repositories
     telegram_public   data/telegram_forwarder.db
     telegram_bot      data/media-cache
```

- 新来源实现 `SourceAdapter`（`validate_locator` / `allocate_source_id` / `fetch`）。`fetch()` **只拉数据，不写库**。
- 新榜单实现 `InsightProduct`，并自带表、配置、路由和任务；不要往 `messages` 或 GitHub 表加类型列。
- 通知有空的 `Notifier` 端口，本轮没有任何通道。企业微信 / 截图 / 投递 HTTP 已从运行时删除；历史 `delivery_*` 表保留在库里，但不提供界面。
- RSS 等非 Telegram 来源还不入库：`messages.message_id` 仍是整数。下一轮需要 `external_id TEXT` 和管理表单。

## 功能

**公共端**

- 只读浏览公开频道消息：来源、关键词、媒体类型、游标分页
- 图片先加载等比缩略图，点击后再拉原图
- 可跳转 Telegram 原文
- GitHub 日 / 周 / 月榜，支持语言、排序和仓库检索
- 可选 OpenAI 兼容接口，为热门仓库生成中文简述

**管理端**

- 添加 `telegram_public`（公开频道 URL）或 `telegram_bot`（数字 `chat_id`）来源
- 新来源默认采集、默认不公开
- 启停采集、立即采集、来源健康、消息检索
- 监测规则与命中确认 / 解决
- 手动刷新 GitHub 榜单

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
GITHUB_ENABLED=true
GITHUB_TOKEN=
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

公开频道启动后立刻抓一次，之后按 `CRAWL_INTERVAL_SECONDS`（默认 300）继续。GitHub 按 `GITHUB_REFRESH_INTERVAL_SECONDS`（默认 1800）刷新。配置了 `TELEGRAM_BOT_TOKEN` 时，才会长轮询 `adapter=telegram_bot` 且已启用的来源。

### HTTPS 反代

Caddy：

```caddy
radar.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:8000
}
```

部署后应满足：HTTPS 根路径免密；`/admin` 才有密钥框；未登录访问 `/api/admin/sources` 返回 401；公网访问裸 `IP:8000` 失败。

## 本地开发

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
cp config/groups.example.yaml config/groups.yaml
cd frontend && npm ci && cd ..

APP_ENV=development \
ADMIN_API_KEY=local-admin-key \
SESSION_SECRET=local-session-secret-at-least-32-bytes \
SESSION_COOKIE_SECURE=false \
uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
```

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

未知 `adapter` 返回 422。本轮管理 UI 仍以公开 URL 表单为主，Bot 以来源 API 配置即可。

## 配置

完整示例见 [`.env.example`](.env.example)。不要提交真实 `.env` 或 `config/groups.yaml`。

| 变量 | 说明 |
| --- | --- |
| `ADMIN_API_KEY` | 管理登录密钥，生产必填且至少 16 字符 |
| `SESSION_SECRET` | 会话 HMAC 密钥，生产至少 32 字节 |
| `SESSION_COOKIE_SECURE` | 生产必须 `true` |
| `TELEGRAM_BOT_TOKEN` | 可选。仅 Bot 来源需要 |
| `GITHUB_TOKEN` | 建议配置（公开仓库只读）。匿名搜索会限流并只采语言列表前 8 项 |
| `GITHUB_AI_*` | 可选中文解读。失败不影响榜单采集 |
| `CRAWL_INTERVAL_SECONDS` | 公开频道采集间隔 |
| `GITHUB_REFRESH_INTERVAL_SECONDS` | GitHub 刷新间隔 |

数据库文件名保持 `data/telegram_forwarder.db`，不要改路径除非你同时改备份脚本。

## 可见性合同（不要改）

- 公共：请求的 `chat_id` 不在公开白名单 → **404**，不是空页
- 公共：未指定来源且没有公开源 → **200** + 空列表
- 管理：列表**不加** `IN (sources.id)`。历史孤儿 `chat_id` 仍能在管理端看到
- 公共媒体：缺失与未公开一律 **404**
- 会话：`tg_session`，HttpOnly，SameSite=Strict，Path=/，登出后 token 立即作废（进程内 sid 表，重启需重新登录）

## 备份与升级

```bash
mkdir -p backups
cp data/telegram_forwarder.db "backups/telegram-forwarder-$(date +%Y%m%d-%H%M%S).db"
tar -czf "backups/data-$(date +%Y%m%d-%H%M%S).tgz" data/
git pull
docker compose up -d --build
```

schema 只做增量 `ALTER`。已有消息和历史 `delivery_*` 行不会被删除。

## 验证

```bash
.venv/bin/python -m unittest discover -s tests -v
cd frontend
npm run test
npm run build
```

部署后还可确认调度器注册 `crawl_public_sources`；GitHub 启用时注册 `refresh_github_rankings`；不再注册 `forward_telegram_to_wecom`。

## 项目布局

```
app/
  main.py                 装配：AppContext、路由、静态资源
  context.py              进程内依赖
  domain/                 用例：来源、资讯流、洞察产品
  ingest/                 SourceAdapter：telegram_public / telegram_bot
  persistence/sqlite/     连接（busy_timeout=5000）与存储
  jobs/                   JobSpec / JobRunner
  notifications/          空 Notifier 端口
  http/                   错误脱敏等 HTTP 辅助
  security.py             会话 HMAC + sid 表
frontend/src/
  features/               公共资讯 / GitHub / 管理入口
config/groups.example.yaml
docs/architecture/        模块化单体设计
```

## 以后怎么加功能

| 要加的东西 | 怎么加 | 不要做 |
| --- | --- | --- |
| 另一种 Telegram 抓取 | 新 `SourceAdapter`，注册进 `AdapterRegistry` | 改 `SQLiteStorage.create_source` 写死类型 |
| RSS | 先做 `external_id TEXT` 和表单，再写 adapter | 把 GUID 硬塞进整数 `message_id` |
| 第二个榜单 | 新 `InsightProduct` + 自己的表/路由/任务 | 往 GitHub 表加产品类型列 |
| 邮件 / Webhook | 实现 `Notifier` 并挂到 `NotificationService` | 复活 WeCom `Forwarder` |
| Postgres / 独立采集进程 | 换 repository；先把会话 sid 落库 | 直接把 uvicorn workers 调到 >1 |

## 许可

本仓库当前为私有仓库。对外分发前请自行补充许可证。
