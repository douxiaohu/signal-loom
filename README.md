# Telegram 资讯与 GitHub 趋势平台

单机可部署的公开资讯聚合服务：采集公开 Telegram 频道，提供免密浏览、检索与媒体查看；同时定期抓取 GitHub 仓库活跃数据，生成日榜、周榜、月榜，并支持语言筛选、全文检索和可选的中文 AI 项目解读。

技术栈为 **FastAPI + React + SQLite**。一个容器、一个进程、一份本地数据库即可运行。应用默认只监听 `127.0.0.1:8000`，公网访问交给同机反向代理或 Tunnel 终止 HTTPS。

| 入口 | 地址 | 访问控制 |
| --- | --- | --- |
| 频道资讯 | `/` | 免密，只展示管理员标记为公开的来源 |
| GitHub 趋势 | `/github` | 免密 |
| 管理中心 | `/admin` | 单管理员密钥登录 |
| 健康检查 | `/health` | 免密，返回 `{"status":"ok"}` |

当前运行时只执行频道采集和 GitHub 刷新，不再执行企业微信投递或截图摘要。历史投递表和兼容只读接口会保留，已有数据可以平滑升级。

## 功能

**公共端**

- 只读浏览公开频道消息，支持来源、关键词、媒体类型筛选和游标分页
- 图片先加载等比缩略图（最长边 1200px），点击后再按需拉取原图
- 消息可跳转 Telegram 原文
- GitHub 日/周/月活跃榜，支持语言、排序和仓库名 / 描述 / topic / 许可证检索
- 可选调用 OpenAI 兼容接口，为热门仓库生成中文简述、项目意义和解决的问题

**管理端**

- 新增公开频道来源，切换公开 / 私有，启停采集，立即采集
- 查看来源健康、消息检索、监测规则和规则命中处理
- 手动触发一次 GitHub 仓库发现与快照刷新

**数据与安全**

- SQLite 增量建表；GitHub 仓库特征使用 FTS5 索引；活动快照保留 40 天
- 新来源默认启用采集但不公开，需管理员确认后再对外展示
- 管理接口要求有效会话；状态变更接口校验同源请求
- 响应不返回原始媒体地址、原始抓取字段或服务器文件路径
- 统一添加 CSP、禁止嵌入和 MIME 嗅探保护头

## 架构

```
浏览器 ──HTTPS──▶ 反向代理 / Tunnel
                      │
                      ▼
              127.0.0.1:8000
              FastAPI（单 worker）
                 │
     ┌───────────┼───────────┐
     ▼           ▼           ▼
  公共页面    管理中心    采集调度
  / /github   /admin     APScheduler
     │                       │
     └────── SQLite ─────────┘
             data/*.db
             data/media-cache
```

- 公共页与管理页是两套 Vite 入口，生产构建后由 FastAPI 直接托管静态文件。
- Telegram 公开频道通过 `t.me/s/...` 页面采集，不依赖 Bot Token。
- GitHub 通过 Repository Search 发现近期活跃仓库，再分批刷新已收录仓库并写入时间快照。
- 榜单综合分由周期内 Stars 增长、Forks 增长、议题变化和推送新鲜度组成。新部署尚未攒满 1 / 7 / 30 天时，页面会显示「建立增长基线中」，先按热度与新鲜度排序。

## 运行环境

| 方式 | 要求 |
| --- | --- |
| Docker 部署 | Docker Engine 20+、Docker Compose v2、约 1 核 / 1GB 内存起步 |
| 本地开发 | Python 3.11+、Node.js 20+、npm |
| 生产暴露 | 同机反向代理（Caddy / Nginx）或 Cloudflare Tunnel；不要把 `8000` 直接映射到公网 |

Linux 服务器请把 `APP_UID` / `APP_GID` 设为部署用户的 `id -u` / `id -g`。容器以非 root 身份运行，同时需要能写入绑定挂载的 `data/`。

## 快速开始（Docker，推荐）

### 1. 获取代码

```bash
git clone git@github.com:<你的用户名>/telegram-github-radar.git
cd telegram-github-radar
```

### 2. 准备配置

```bash
cp .env.example .env
cp config/groups.example.yaml config/groups.yaml
```

生成管理密钥和会话密钥（生产环境缺少管理密钥、或会话密钥不足 32 字节时，服务会拒绝启动）：

```bash
# 写入 .env
ADMIN_API_KEY=$(openssl rand -hex 24)
SESSION_SECRET=$(openssl rand -hex 32)
```

至少确认这些值：

```bash
DATABASE_URL=sqlite:///./data/telegram_forwarder.db
TIMEZONE=Asia/Shanghai
CRAWL_INTERVAL_SECONDS=300
GROUPS_CONFIG_PATH=config/groups.yaml
ADMIN_API_KEY=        # 上一步生成，不要用占位值
SESSION_SECRET=       # 上一步生成，至少 32 字节
SESSION_TTL_HOURS=12
SESSION_COOKIE_SECURE=true
APP_ENV=production
APP_UID=1000          # Linux 上改为 id -u
APP_GID=1000          # Linux 上改为 id -g
MEDIA_CACHE_DIR=./data/media-cache
GITHUB_ENABLED=true
GITHUB_TOKEN=         # 强烈建议配置，见下文
```

`config/groups.yaml` 只在首次启动时把已有来源种入 `sources` 表。种入之后，公开范围和启停状态都在管理中心维护：

```yaml
groups:
  - source: "https://t.me/zaihuapd"
    name: "zaihuapd"
```

只接受公开 Telegram 用户名链接，例如 `https://t.me/channel`、`https://t.me/s/channel` 或 `@channel`。不支持邀请链接和任意 URL。

### 3. 创建 Compose 外部网络

当前 `docker-compose.yml` 接入了一个外部网络 `ai-internal`，用于和同机其他服务互通。全新机器上需要先创建，否则 Compose 会启动失败：

```bash
docker network create ai-internal
```

如果这台机器不需要接入其他内部服务，也可以先删掉 `docker-compose.yml` 里的 `ai-internal` 网络声明，只保留默认网络。

### 4. 启动

```bash
mkdir -p data/media-cache
docker compose up -d --build
```

或使用仓库脚本（同样要求已存在 `.env` 和 `config/groups.yaml`）：

```bash
bash scripts/deploy.sh
```

检查：

```bash
curl -sS http://127.0.0.1:8000/health
# {"status":"ok"}
```

首次启动后，公开 `t.me/...` 来源会立即抓取一次，之后按 `CRAWL_INTERVAL_SECONDS`（默认 300 秒）继续采集。GitHub 采集同样启动即跑，之后按 `GITHUB_REFRESH_INTERVAL_SECONDS`（默认 1800 秒）更新。

### 5. 用反向代理提供 HTTPS

应用端口只绑定本机回环地址。下面是 Caddy 示例，把 `radar.example.com` 换成你的域名：

```caddy
radar.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:8000
}
```

Nginx 示例：

```nginx
server {
    listen 443 ssl http2;
    server_name radar.example.com;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

部署完成后应满足：

- HTTPS 根路径免密显示公开频道；`/admin` 才出现管理密钥输入框
- 未登录访问 `/api/admin/sources` 返回 401
- `/api/public/sources` 只包含公开且启用的来源
- 从公网访问裸 `服务器IP:8000` 应失败；HTTPS 域名 `/health` 返回 200

## 本地开发

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
cp config/groups.example.yaml config/groups.yaml
cd frontend && npm ci && cd ..
```

后端：

```bash
APP_ENV=development \
ADMIN_API_KEY=local-admin-key \
SESSION_SECRET=local-session-secret-at-least-32-bytes \
SESSION_COOKIE_SECURE=false \
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

前端（Vite 会把 `/api` 代理到后端）：

```bash
cd frontend
npm run dev
```

开发时浏览器打开 Vite 端口即可。本地可以把 `SESSION_COOKIE_SECURE` 设为 `false`，生产环境必须为 `true`。

## 配置说明

完整示例见 [`.env.example`](.env.example)。不要把真实 `.env` 或 `config/groups.yaml` 提交进仓库。

### 基础与安全

| 变量 | 说明 |
| --- | --- |
| `ADMIN_API_KEY` | 管理中心登录密钥，生产必填 |
| `SESSION_SECRET` | 会话签名密钥，生产至少 32 字节 |
| `SESSION_TTL_HOURS` | 会话有效期，默认 12 小时 |
| `SESSION_COOKIE_SECURE` | 生产必须 `true`，仅 HTTPS 下发送 Cookie |
| `APP_ENV` | `production` 或 `development` |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_WINDOW_SECONDS` | 登录失败限流，默认 15 分钟内 5 次 |
| `TIMEZONE` | 调度与展示时区，默认 `Asia/Shanghai` |
| `DATABASE_URL` | 默认 `sqlite:///./data/telegram_forwarder.db` |
| `MEDIA_CACHE_DIR` | 图片缓存目录 |
| `CRAWL_INTERVAL_SECONDS` | 公开频道采集间隔 |
| `SOURCE_STALE_AFTER_SECONDS` | 来源超过该秒数未更新则视为过期 |
| `TELEGRAM_BOT_TOKEN` | 可选。仅在使用 Bot API `chat_id` 来源时需要；公开页面抓取不需要 |

### GitHub 排行榜

匿名搜索受 10 次/分钟限制，且只采集配置语言列表的前 8 项。生产环境建议配置 fine-grained token（公开仓库只读即可）。令牌不会返回浏览器，也不会写入数据库。

| 变量 | 说明 |
| --- | --- |
| `GITHUB_ENABLED` | 是否启用 GitHub 采集，默认 `true` |
| `GITHUB_TOKEN` | 建议配置，扩大语言覆盖和刷新批次 |
| `GITHUB_REFRESH_INTERVAL_SECONDS` | 刷新间隔，默认 1800 |
| `GITHUB_LANGUAGES` | 逗号分隔语言列表 |
| `GITHUB_CANDIDATES_PER_LANGUAGE` | 每种语言每轮发现的候选数 |
| `GITHUB_MIN_STARS` | 最低 Stars 门槛 |

搜索接口参数与限流见 [GitHub REST API：Search](https://docs.github.com/en/rest/search/search?apiVersion=2022-11-28)。

### 可选：中文 AI 项目解读

兼容 OpenAI Chat Completions 接口。未启用或调用失败时，排行榜仍展示 GitHub 原始简介与主语言，不会中断采集。

```bash
GITHUB_AI_ENABLED=true
GITHUB_AI_API_KEY=
GITHUB_AI_BASE_URL=https://api.openai.com/v1
GITHUB_AI_MODEL=
GITHUB_AI_TIMEOUT_SECONDS=45
GITHUB_AI_REPOSITORIES_PER_REFRESH=6
```

服务会为每轮最热门的若干仓库额外获取 README 与语言字节构成，再生成「中文简述 / 项目意义 / 解决问题」。输入内容、模型和语言构成未变化时直接复用 SQLite 缓存。

## 使用流程

1. 用 `ADMIN_API_KEY` 登录 `/admin`。
2. 添加公开频道，例如 `https://t.me/s/tnews365`。新来源默认采集、默认不公开。
3. 在管理中心确认内容后，把来源切换为公开；公共首页立即可见。
4. 需要时点击「立即采集」，或等待定时任务。
5. 打开 `/github` 查看趋势。需要立刻刷新时，在管理中心触发 GitHub 采集。
6. 可按关键词、媒体类型配置监测规则，并在命中记录里确认或解决。

`t.me` 解析异常时，采集器会尝试 `telegram.me` 回退地址。Bot API 长轮询仅在配置了 `TELEGRAM_BOT_TOKEN` 时启动。

## 页面与 API

公共：

- `GET /`、`GET /github`
- `GET /api/public/sources`
- `GET /api/public/messages`：来源、关键词、媒体、游标分页
- `GET /api/public/media/{message_id}/{index}?variant=thumbnail|original`
- `GET /api/public/github/rankings`：`period`、`language`、`query`、`sort`、分页

管理：

- `POST /api/auth/login`、`GET /api/session`、`POST /api/auth/logout`：HttpOnly 会话
- `GET/POST /api/admin/sources`、`PATCH /api/admin/sources/{chat_id}`
- `POST /api/admin/sources/{chat_id}/crawl-now`
- `GET /api/admin/messages`、`GET /api/admin/media/...`
- `GET /api/admin/operations/summary`
- `GET/POST /api/admin/rules`、`PATCH /api/admin/rules/{id}`
- `GET /api/admin/matches` 及确认 / 解决接口
- `POST /api/admin/github/refresh`

公开 API 使用 ETag 和 `no-cache`；管理与媒体缓存使用私有策略。

## 备份与升级

升级前先备份 SQLite 与整个数据目录：

```bash
mkdir -p backups
cp data/telegram_forwarder.db "backups/telegram-forwarder-$(date +%Y%m%d-%H%M%S).db"
tar -czf "backups/data-$(date +%Y%m%d-%H%M%S).tgz" data/
```

然后拉取新代码并重建容器：

```bash
git pull
docker compose up -d --build
```

数据库采用增量建表，已有消息和历史投递数据不会被删除。

## 验证

```bash
.venv/bin/python -m unittest discover -s tests -v
cd frontend
npm run test
npm run build
npm run test:e2e
```

Playwright 覆盖 `1440×900`、`768×1024` 和 `390×844`，检查公开免密、管理登录、键盘操作、完整图片、减少动态效果、无横向溢出和 WebGL 不可用。前端初始 JavaScript 原始体积预算为 250KB。

部署后还可快速确认：

- 调度器注册 `crawl_public_sources`
- GitHub 启用时同时注册 `refresh_github_rankings`，`/github` 能显示采集状态和更新时间

## 常见问题

**Compose 报错 `network ai-internal declared as external, but could not be found`**  
先执行 `docker network create ai-internal`，或不需要内部互通时去掉该外部网络。

**生产启动失败，提示缺少密钥**  
检查 `ADMIN_API_KEY` 是否为空，以及 `SESSION_SECRET` 是否至少 32 字节。不要直接使用示例占位值。

**GitHub 榜单几乎是空的，或很快触发限流**  
未配置 `GITHUB_TOKEN` 时只采集语言列表前 8 项，且受匿名搜索配额限制。配置只读 token 后会采集完整语言列表并扩大刷新批次。新部署前几天会显示「建立增长基线中」，这是预期行为。

**公共首页没有消息**  
新来源默认不公开。到 `/admin` 确认内容后，再把来源切换为公开。

**图片打不开**  
媒体由后端缓存代理，不直接把 Telegram 原始地址暴露给浏览器。确认 `data/media-cache` 对容器可写，且 `APP_UID` / `APP_GID` 与宿主机目录属主一致。

**需要 Bot Token 吗**  
浏览和采集公开频道不需要。只有当你要把 Bot 拉进的群组 / 频道作为 `chat_id` 来源时，才配置 `TELEGRAM_BOT_TOKEN`。

## 项目结构

```
app/                 FastAPI 应用、采集、存储、安全
config/              groups.example.yaml（示例）；groups.yaml 不入库
data/                SQLite 与媒体缓存，不入库
frontend/            React 公共页、GitHub 页、管理页
scripts/deploy.sh    Docker Compose 一键构建启动
tests/               后端单元测试
```

## 许可

本仓库当前为私有仓库。对外分发前请自行补充许可证。
