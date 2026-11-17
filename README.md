<div align="center">

# 频道资讯 · The Daily Signal

**从公开频道，拾取值得停留的声音。**

Telegram 公开频道聚合 · 安静阅读 · 完整图片 · 长文与多图分享

![Go 1.26+](https://img.shields.io/badge/Go-1.26%2B-00ADD8?style=flat-square&logo=go&logoColor=white)
![React 19](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-single_instance-526B44?style=flat-square&logo=sqlite&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-ready-2496ED?style=flat-square&logo=docker&logoColor=white)

[在线阅读](https://douxiaohu.duckdns.org) · [快速开始](#快速开始) · [本地开发](#本地开发) · [配置](#配置) · [文档导航](#文档导航)

</div>

![频道资讯首页：纸张阅读室与植物插画](docs/images/reading-room.png)

> 一个可以单机部署的资讯阅读站。Go 负责采集、权限与媒体缓存，React 提供公开阅读页和独立管理中心；一份 SQLite 保存消息与来源，日常浏览无需登录。

## 这一版能做什么

| 阅读与分享 | 采集与管理 |
| --- | --- |
| 来源、关键词、媒体类型筛选，URL 保留检索条件 | 添加公开 Telegram 频道，启停与立即采集 |
| 纸张日间与夜间阅读，滚动触发逐字组装 | 频道健康、采集状态、消息检索 |
| 植物生长动效、Alfama 水彩城市页脚 | 监测规则与命中确认、解决 |
| 图片按完整比例展示，点击查看原图 | 概览、访问统计与反馈管理 API |
| 长文不截断、多图不裁切，自动生成分享分页 | 新增来源默认采集，单独控制是否公开 |
| 复制当前页、下载 PNG 或整套 PNG 的 ZIP | 管理密钥登录、会话与同源写入校验 |

### 界面与动效

页面使用暖白纸张、中文衬线标题和橄榄绿控件。介绍区的游标会拉框、排字；消息进入视口后逐字显现，图片优先展开，单卡动画最多约 3.2 秒。点击、键盘操作会立即显示完整内容；开启“减少动态效果”时直接显示完成状态。

![Alfama 夜间页脚：水彩城市、星空与窗灯](docs/images/alfama-night.png)

### 分享保留完整内容

- 正文按实际字体测量换行，保留段落；长文自动分页。
- 按附件顺序加入全部静态图片，优先原图，完整等比绘制。
- 单页逻辑尺寸不超过 1080 × 2600，输出 PNG 不超过 1620 × 3900，避免无限长画布。
- 每页都有来源、页号和网站链接 `https://douxiaohu.duckdns.org`。
- 单页下载 PNG，多页一次下载 ZIP；图片加载失败时明确标记位置。

页面截图展示界面样式，统计数字和消息内容以实际数据为准。分享图片目前使用本站公网地址；自部署时可在 [`frontend/src/lib/shareCard.ts`](frontend/src/lib/shareCard.ts) 修改 `WEBSITE_URL`。

## 运行结构

```mermaid
flowchart LR
    Reader[浏览器] --> Proxy[HTTPS 反向代理]
    Proxy --> HTTP[Go HTTP 服务]
    HTTP --> Public[公开资讯与媒体]
    HTTP --> Admin[管理会话与操作]
    Public --> Storage[(SQLite)]
    Admin --> Storage
    Collector[频道采集调度] --> Telegram[Telegram 公开频道页]
    Collector --> Storage
    Collector --> Cache[本地媒体缓存]
    Public --> Cache
```

**运行时是 Go + React 19 + SQLite。** 历史 Python/FastAPI 实现保留在 `app/` 和 `tests/`，当前 Docker 镜像执行 `cmd/server` 构建出的 Go 程序。

| 入口 | 路径 | 访问方式 |
| --- | --- | --- |
| 公开阅读 | `/` | 无需登录，只展示已启用且公开的来源 |
| 管理中心 | `/admin` | 管理密钥登录 |
| 公开 API | `/api/public/*` | 来源、消息、媒体与反馈 |
| 管理 API | `/api/admin/*` | 需要有效管理会话 |
| 健康检查 | `/health` | `{"status":"ok"}` |

服务、采集器和 SQLite 写入运行在一个进程中。**同一份数据库只运行一个应用实例**；管理会话在内存中保存，重启后需重新登录。

## 快速开始

需要 Docker Engine、Compose 和可访问 Telegram 频道页的服务器网络。镜像构建需要访问 npm、Go 模块与基础镜像仓库。

### 1. 获取代码与配置

```bash
git clone https://github.com/douxiaohu/telegram-github-radar.git
cd telegram-github-radar
cp .env.example .env
cp config/groups.example.yaml config/groups.yaml
mkdir -p data/media-cache
```

源码托管于 [douxiaohu/telegram-github-radar](https://github.com/douxiaohu/telegram-github-radar)。

### 2. 设置密钥

分别运行以下命令，将输出填入 `.env` 的 `ADMIN_API_KEY` 和 `SESSION_SECRET`：

```bash
openssl rand -hex 24
openssl rand -hex 32
```

确认以下配置：

```dotenv
APP_ENV=production
ADMIN_API_KEY=<第一条命令生成的管理密钥>
SESSION_SECRET=<第二条命令生成的会话密钥>
SESSION_COOKIE_SECURE=true
DATABASE_URL=sqlite:///./data/telegram_forwarder.db
TIMEZONE=Asia/Shanghai
APP_UID=1000
APP_GID=1000
```

Linux 上将 `APP_UID`、`APP_GID` 设置为部署用户对应的 UID/GID，保证持久化目录可写。容器内 `HOST` 保持为空，`PORT` 使用默认 8000。

### 3. 启动

当前 Compose 引用外部网络 `ai-internal`，首次部署先创建：

```bash
docker network inspect ai-internal >/dev/null 2>&1 || docker network create ai-internal
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:8000/health
```

Compose 将服务发布到 **`127.0.0.1:8000`**。生产环境通过同机 HTTPS 反向代理访问；安全 Cookie 要求使用 HTTPS 登录管理中心。

<details>
<summary><strong>Caddy 反向代理示例</strong></summary>

```caddy
radar.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:8000
}
```

反向代理需保留浏览器原始 `Host`，传递 `X-Forwarded-For`。Nginx 对应设置为 `proxy_set_header Host $host;`。服务会校验写请求的 `Origin` 与 `Host`；修改 Host 可能导致登录或操作返回 403。

`TRUSTED_PROXIES` 只配置实际可信的代理 IP/CIDR。通过 CDN 或额外网关接入时，需要结合真实链路配置，才能正确统计客户端地址和执行限流。

</details>

### 4. 管理来源

打开 `/admin`，使用管理密钥登录，再添加频道名称和 `https://t.me/channel`。新增频道默认采集、默认不公开，确认内容后再启用公开展示。

`config/groups.yaml` 用于**空 sources 表的首次初始化**。示例：

```yaml
groups:
  - source: "https://t.me/zaihuapd"
    name: "zaihuapd"
  - source: "https://t.me/s/tnews365"
    name: "竹新社"
```

初始化文件导入的有效公开频道默认采集且公开；修改 YAML 不会覆盖数据库中的已有来源。启动时采集一次，之后默认每 300 秒继续采集。

> 当前 Go 版本支持 `telegram_public`。`telegram_bot`、Bot 长轮询和 RSS 尚未接入 Go 运行时；`TELEGRAM_BOT_TOKEN` 只为兼容旧配置保留。

## 本地开发

需要 **Go 1.26+、Node.js 22 LTS 和 npm**。不需要 Python 来运行当前应用。

```bash
cp .env.example .env
cp config/groups.example.yaml config/groups.yaml
mkdir -p data/media-cache
cd frontend
npm ci
npm run build
cd ..
```

在第一个终端启动后端：

```bash
APP_ENV=development \
HOST=127.0.0.1 \
SESSION_COOKIE_SECURE=false \
go run ./cmd/server
```

从 `.env` 读取已设置的密钥。开发环境缺少密钥时会生成临时值，临时管理密钥写入本地启动日志；生产不会使用临时密钥。

在第二个终端启动前端：

```bash
cd frontend
npm run dev -- --host 127.0.0.1
```

Vite 在终端显示本地地址，并把 `/api` 代理到 `127.0.0.1:8000`。本地 HTTP 登录需使用 `SESSION_COOKIE_SECURE=false`；生产必须为 `true`。

## 配置

完整配置及默认值见 [`.env.example`](.env.example)。进程环境变量优先于 `.env`。

| 变量 | 用途 / 默认值 |
| --- | --- |
| `APP_ENV` | `production` / `staging` / `development` / `test`；无法识别的值拒绝启动 |
| `ADMIN_API_KEY` | 管理密钥，至少 16 字符 |
| `SESSION_SECRET` | 会话 HMAC 密钥，至少 32 字节 |
| `SESSION_COOKIE_SECURE` / `SESSION_TTL_HOURS` | HTTPS Cookie / 会话时长，默认 `true` / `12` |
| `HOST` / `PORT` | 监听地址 / 端口，默认所有网卡 / `8000` |
| `DATABASE_URL` | 默认 `sqlite:///./data/telegram_forwarder.db` |
| `GROUPS_CONFIG_PATH` | 首次初始化来源，默认 `config/groups.yaml` |
| `CRAWL_INTERVAL_SECONDS` | 采集间隔，默认 `300` |
| `SOURCE_STALE_AFTER_SECONDS` | 来源延迟判断阈值，默认 `900` |
| `TIMEZONE` | 静默时段、访问统计时区，默认 `Asia/Shanghai` |
| `TRUSTED_PROXIES` | 可信代理 IP/CIDR 或 `private` / `loopback` / `none` |
| `MEDIA_CACHE_DIR` | 默认 `./data/media-cache` |
| `MEDIA_ALLOWED_HOSTS` | 默认 `telesco.pe,cdn-telegram.org` 及其子域，仅 HTTPS |
| `MEDIA_MAX_BYTES` | 单文件缓存上限，默认 96 MiB |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_WINDOW_SECONDS` | 登录限流，默认 5 次 / 900 秒 |
| `FEEDBACK_RATE_LIMIT` / `FEEDBACK_RATE_WINDOW_SECONDS` | 反馈限流，默认 5 次 / 60 秒 |

真实 `.env`、`config/groups.yaml`、数据目录、发布包和本地备份不提交到 GitHub。

## 数据与访问边界

- 公开消息与媒体只允许访问**启用且已公开**的来源；指定未公开来源时返回 404。
- 没有公开来源时，公开列表正常返回空集合。
- 管理端保留历史孤儿消息的查询能力，来源删除或变化不等于删除历史消息。
- 管理会话使用 HttpOnly / SameSite=Strict Cookie；登出立即作废。
- 写请求要求 JSON，并执行同源校验和请求体大小限制；开发环境部分规则放宽。
- 媒体由服务端按白名单缓存，返回给浏览器的是本站媒体路径。
- 前端未知无扩展名路径可能回退到首页；不能仅凭 `/docs` 返回 200 判断暴露了 API 文档。未知 `/api/*` 返回 JSON 404。

## 检查与测试

```bash
# Go 后端：接口、认证、采集、SQLite、媒体与配置
go test ./...
go vet ./...

# 前端：组件测试与生产构建
cd frontend
npm ci
npm test
npm run build

# 浏览器回归：首次使用需安装 Chromium
npx playwright install chromium
npm run test:e2e
```

浏览器测试覆盖 1440px、768px 和 390px 三种宽度，使用 API 测试数据验证检索、图片查看、动效、主题、权限入口、长文与多图分享；不会写入生产数据库。

生产构建同时检查原始 JavaScript 体积：阅读代码 **260 KiB**、按需 Assembly **36 KiB**、按需分享导出 **16 KiB**。插画为本地静态资源，接近视口时再加载。

## 备份与升级

SQLite 开启 WAL 时，使用在线备份接口，避免只复制正在写入的主数据库文件。若宿主机安装了 `sqlite3`：

```bash
mkdir -p backups
sqlite3 data/telegram_forwarder.db ".backup 'backups/telegram-forwarder-before-upgrade.db'"
```

使用独立时间戳目录保存数据库快照、媒体、生产配置和当前镜像引用。前端发布还应保存原静态资源，避免旧页面的动态导入失效。

```bash
# 备份完成后，在同一检出目录更新代码
git pull --ff-only
docker compose build telegram-forwarder
docker compose up -d --no-build telegram-forwarder
curl -fsS http://127.0.0.1:8000/health
```

升级后检查公开页面、媒体、分享导出和匿名管理 API 的 401。**前端回滚使用旧镜像，保留当前数据库**，避免覆盖发布后正常采集的数据。线上实际发布过程与回滚信息见[发布记录](docs/releases/2026-11-17-share-website-link-release.md)。

## 目录导航

```text
cmd/server/             Go 应用入口：配置、仓储、调度与 HTTP 装配
internal/
  api/                  公开 / 管理 API、会话与静态资源路由
  config/               环境配置、来源初始化与校验
  crawler/              Telegram 公开频道采集
  media/                媒体下载、缓存与等比缩略图
  model/                领域数据与 API DTO
  repository/           SQLite 读写、迁移与统计
  safe/                 后台任务容错与错误脱敏
  scheduler/            单进程采集调度
frontend/
  src/components/       阅读、管理、媒体与分享组件
  src/components/editorial/  Assembly、植物与风景页脚
  src/lib/shareCard.ts   完整文字、多图分页与 PNG / ZIP 导出
  src/styles/           日夜主题与界面样式
  src/vendor/delineate/ 上游绘图引擎与 MIT 许可
  public/artwork/       本地插画资源
  test/                 前端单元测试
  e2e/                  三尺寸浏览器测试
config/                 来源配置示例
docs/                   架构决定、设计与发布记录
app/ · tests/           历史 Python 实现与测试
```

## 文档导航

| 主题 | 文档 |
| --- | --- |
| 完整环境配置 | [`.env.example`](.env.example) |
| 纸张阅读室与动效集成 | [界面设计决定](docs/architecture/notes/implemented/feature/2026-11-17-editorial-assembly-reading-room.md) |
| 长文、多图与分页导出 | [媒体与分享修复](docs/architecture/notes/implemented/bug-fix/2026-11-17-complete-media-and-paged-share-cards.md) |
| 界面发布与回滚 | [前端发布记录](docs/releases/2026-11-17-editorial-ui-release.md) |
| 分享网站链接上线 | [链接修正发布](docs/releases/2026-11-17-share-website-link-release.md) |
| 早期架构取舍 | [模块化单体设计（历史设计，含 Python 阶段）](docs/architecture/2026-08-13-modular-monolith.md) |
| 上游源码与许可 | [delineate 集成说明](frontend/src/vendor/delineate/README.md) |

## 致谢与许可

界面参考 [appautomaton/delineate](https://github.com/appautomaton/delineate) 的 Assembly、Climate Garden 和 Alfama。复用代码及绘图保留原 MIT 许可，见 [`frontend/src/vendor/delineate/LICENSE`](frontend/src/vendor/delineate/LICENSE) 和插画目录的[许可文件](frontend/public/artwork/LICENSE-delineate.txt)。

本项目源码公开，尚未为项目自身声明统一开源许可证；上游 MIT 许可只适用于对应的复用部分。
