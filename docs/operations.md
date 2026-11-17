# 配置、备份与制品发布

## 自部署

默认 Compose 不依赖任何外部网络。先复制 `.env.example` 与 `config/groups.example.yaml`，设置独立的管理密钥和会话密钥，再执行 `docker compose up -d --build`。服务只绑定 `127.0.0.1:8000`，由 HTTPS 反向代理对外提供访问。

`SITE_NAME`、`SITE_DESCRIPTION` 与 `PUBLIC_BASE_URL` 控制运行中的站点品牌和分享链接，无需改前端源码。网址填写站点 origin，例如 `https://signal.example.com`，不含路径、查询、片段或凭据。开发环境可以留空，浏览器使用当前 origin。公开配置接口仅有三个公开字段，不包含密钥。

现有服务器需要共享 `ai-internal` 时使用：

```bash
docker network inspect ai-internal >/dev/null 2>&1 || docker network create ai-internal
docker compose -f docker-compose.yml -f docker-compose.server.yml up -d --build
```

## 缓存策略

- `MEDIA_MAX_BYTES`：单个媒体文件上限，默认 96 MiB。
- `MEDIA_CACHE_MAX_BYTES`：总缓存软上限，默认 5 GiB。
- `MEDIA_CACHE_MAX_AGE_DAYS`：按最近使用时间计算的保留天数，默认 30 天。

启动及每 15 分钟检查一次。总量超过上限时从较久未使用的缓存开始回收；临时下载和无关文件不参与回收。后台“缓存空间”可查看容量、文件数和保留时长，并立即执行同一维护策略。清理不删除数据库消息，缓存缺失后按需访问原媒体；上游失效的媒体不能保证重新获取。首次启用年龄策略时，过期历史缓存获得一个完整保留周期的宽限，之后正常按年龄回收；容量上限仍按配置执行。缓存不是永久归档，需要永久保存的媒体应另外备份。

## SQLite 在线备份与恢复演练

本机安装 Python 3.8+ 即可，不要求 sqlite3 命令行工具：

```bash
python3 scripts/release.py backup \
  data/telegram_forwarder.db \
  backups/before-upgrade.db
```

备份使用 SQLite 在线接口，包含 WAL 中已提交的内容，并执行完整性检查；目标存在时拒绝覆盖。凭据、数据库、媒体与备份不进入 Git 或发布包。恢复演练在独立目录进行，先检查 `PRAGMA integrity_check` 和来源/消息数量，再用独立实例检查页面；不让演练实例连接生产来源或生产数据库。

## 构建可验证制品

需要 Go 1.27.4+、Node.js 22、Python 3.8+ 与经校验的 Gitleaks 8.30.1。先提交代码，保证发布版本对应明确的提交。

```bash
go test -race ./...
go vet ./...
python3 -m unittest discover -s scripts/tests -v
npm --prefix frontend ci
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend run test:e2e
bash scripts/install-gitleaks.sh
mkdir -p bin outputs/releases
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
  -trimpath -ldflags="-s -w" -o bin/signal-loom ./cmd/server
python3 scripts/release.py package \
  --binary bin/signal-loom \
  --platform linux/amd64 \
  --output outputs/releases/release.tar.gz
python3 scripts/release.py verify-package outputs/releases/release.tar.gz
```

ARM64 服务器使用 `GOARCH=arm64` 和 `--platform linux/arm64`。打包器要求工作区已提交，二进制的 Go VCS 元数据与当前提交一致且未标记 dirty，并检查 ELF 架构、白名单文件、符号链接和摘要。打包前还对实际构建产物执行敏感内容扫描，遮盖后的本地报告留在输出目录。发布包只包含程序、前端构建产物和校验清单，不同步整个工作区。

## 发布到现有服务器

现有应用目录应具有 `docker-compose.yml`，服务名为 `telegram-forwarder`，持久化目录挂载到 `/app/data`。Docker 和 Python 3.8+ 需已安装，SSH 使用现有密钥或代理认证。工具保留原容器的环境、挂载和端口，只通过明确参数设置新的公开站点网址。

```bash
python3 scripts/release.py deploy outputs/releases/release.tar.gz \
  --host racknerd-vps \
  --app /opt/telegram-forwarder \
  --container telegram-forwarder \
  --port 8000 \
  --public-url https://signal.example.com
```

`scripts/release-vps.sh` 是上述命令的兼容入口，首个参数同样是发布包。发布流程：

1. 本地验证包清单，上传后再次比对 SHA-256。
2. 备份现有镜像、私有运行配置和 SQLite；备份只在服务器私有目录保留。
3. 在原镜像上替换程序和前端，保留旧静态 assets，避免已打开页面的动态导入失效。
4. 候选以无网络、无宿主端口、独立临时数据库启动，禁止导入生产来源。
5. 切换后逐文件校验 HTTP 内容，核对来源权限、消息数量、挂载、端口和匿名管理 401。
6. 失败自动恢复原镜像与原环境；不恢复数据库覆盖发布期间的新消息。

每版证据在 `/opt/releases/signal-loom/<release>/`，备份在 `/opt/backups/signal-loom/<release>/`。`private-state.json`、环境覆盖和容器检查结果含私有配置，不上传 GitHub。`result.json` 是不含密钥的发布摘要。

发布工具保存实际运行环境覆盖文件。日后手动重建应保留这份覆盖，或把公开站点配置同步到私有 `.env`；不要只运行旧目录的构建命令替换制品镜像。

## 回滚

在服务器上执行指定版本目录内的工具：

```bash
python3 /opt/releases/signal-loom/<release>/release.py rollback \
  /opt/releases/signal-loom/<release>
```

只恢复镜像与先前运行环境，保留当前数据库。数据库恢复是独立的人工运维操作，必须先确认是否会丢失后续采集消息。

## 自动检查

GitHub Actions 包含竞态测试、静态检查、前端与浏览器测试、构建预算、发布工具测试、Go/npm 依赖检查、Gitleaks 和 Docker 构建。Gitleaks 8.30.1 下载时核对官方 SHA-256；配置测试的固定假数据按“特定文件且精确值”允许，其他测试内容不豁免。扫描结果中的密钥全部遮盖。

依赖机器人为 Go、npm 和 GitHub Actions 定期创建更新 PR。CI 不使用生产凭据，也不会自动部署。
