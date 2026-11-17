# 2026-11-17 资讯前端发布记录

状态：已上线，公网验收通过。

- 线上入口：https://douxiaohu.duckdns.org
- 发布标识：`ui-20261117-113453-editorial`
- 应用目录：`/opt/telegram-forwarder`
- 发布暂存与服务端结果：`/opt/releases/telegram-forwarder/ui-20261117-113453-editorial`
- 本地证据：`outputs/releases/ui-20261117-113453-editorial/`
- 本次工作树的前端改动已发布；原始 Git 基线为 `2a925ae`，本次没有执行 Git 推送。

## 发布内容与方式

上线纸张阅读室、Assembly 介绍区与消息逐字组装、植物动效、Alfama 日夜页脚、图片完整比例展示，以及全文/多图分享分页、PNG 与 ZIP 下载修复。消息动画使用两倍节奏，优先显示图片，单卡约 3.2 秒完成。

本次只发布前端。服务器源码基线与本地修改前一致，上传包 SHA-256 为 `3b38914ea614e28c4e5b61bb25e2b73714e63128106a32ed212ab21e43af4b40`。候选镜像以原生产镜像为基础，仅复制前端 dist；同时同步前端源码以便后续重建。选择此方式是为了避免前端发布顺带替换生产后端或环境。

镜像保留上一版带哈希的 assets，已打开的旧页面仍可请求其依赖。发布前使用独立数据目录、无网络、无宿主端口的隔离容器验证候选，未启动第二个生产数据库写者。

- 新镜像：`sha256:4b37d0c95bec0073df0c24567d3c30d4cfdcd7c4bde049e086dc01a9c2067a12`
- 回滚镜像标签：`telegram-forwarder-ui-rollback:ui-20261117-113453-editorial`
- 默认运行镜像名：`telegram-forwarder_telegram-forwarder`
- 后端二进制 SHA-256：`1cd1443ed055969c99a9b3f2b2d810fb526143d4a8ff10ae6fd914896a30927e`，发布前后相同。

## 验收证据

- 生产容器健康；`/health` 返回 200 / `{"status":"ok"}`。
- 23 个发布静态文件经 HTTP 读取后逐一匹配构建清单，包括入口、JS、CSS、字体和插画。
- HTTPS 首页返回内容与新入口 SHA-256 匹配：`04cc6b92e34442e287ecc78973afaac4b6c739a9b3e1500ff2de87f64b5f33d9`。
- 公网浏览器成功显示新首页和 20 条真实消息；纯文字分享 PNG 为 1620×1260。
- 公网“图片”筛选中的真实图片正常加载，缩略图自然尺寸 480×270，CSS 为 contain；对应带图分享 PNG 为 1620×2226，无图片失败提示。
- 两次公网浏览器检查均无页面脚本错误。
- `/admin` 显示管理密钥登录界面；匿名 `/api/admin/sources` 返回 401。
- 环境变量、`.env`、groups 配置、Dockerfile、Compose 文件和来源 ID/公开状态经比对未改变；8000 端口仍只发布到 127.0.0.1。
- 备份时消息数 5505，切换后 5506，正常采集继续，历史数据保留。

发布前已通过前端生产构建、215 项单元测试和三尺寸浏览器回归，另有多图导出 ZIP 的 CRC 与逐页 PNG 尺寸验证。公网检查使用真实公开数据；没有进行管理员实际登录或业务写入验收。

## 兼容性核验

服务器使用 Docker 26.1.3 / docker-compose 1.25.0。重建容器使用 `COMPOSE_API_VERSION=1.41`，避免旧 Compose 依赖的 ContainerConfig 字段在新 API 中缺失。

第一次切换的检查把 `/docs` 预期写为 404，触发了自动回滚。随后在回滚镜像上确认：原生产后端的 `/docs` 本来就返回公开首页，响应体 SHA-256 与旧 index.html 完全一致，不是 API 文档。核验改为严格匹配此既有首页回退行为后重新发布成功；没有为此更换或放宽后端权限。

## 备份与回滚

备份目录：`/opt/backups/telegram-forwarder/ui-20261117-113453-editorial`。其中包含原前端、被替换源码、配置副本、镜像引用和 SQLite 在线备份。敏感配置与容器检查数据只保存在服务器的 root 私有目录，没有取回本地或写入此记录。

快速回滚运行镜像：

```bash
cd /opt/telegram-forwarder
docker tag telegram-forwarder-ui-rollback:ui-20261117-113453-editorial telegram-forwarder_telegram-forwarder
COMPOSE_API_VERSION=1.41 docker-compose \
  -f docker-compose.yml \
  -f /opt/releases/telegram-forwarder/ui-20261117-113453-editorial/runtime-preserve.json \
  up -d --no-build --force-recreate telegram-forwarder
```

该操作恢复旧运行镜像并保留当前数据库。若要长期撤销前端源码，另从备份恢复被替换源码；不要为前端回滚恢复数据库，否则会丢失发布后的正常采集消息。发布脚本首次失败时已验证过自动恢复旧镜像和前端，原数据库未被回退。
