# 2026-11-17 拾讯 · Signal Loom 更名与文档发布

状态：已上线，公网名称、真实图片分享与匿名管理权限核验通过。

项目展示名称统一为「拾讯 · Signal Loom」，覆盖首页、页脚、浏览器标题、管理入口、分享 PNG 和下载文件名。GitHub 简介与站点链接同步更新。GitHub 仓库现名为 [douxiaohu/signal-loom](https://github.com/douxiaohu/signal-loom)，克隆示例与采集器的项目链接使用新地址。持久化配置名称保持兼容。

## 代码与文档

- 代码与文档提交：`d4a2fee`。
- 简体中文主文档及 English、日本語、Español 三个翻译版本，各包含 14 张功能截图，以及功能介绍、安装、配置、开发、测试和备份说明。
- 截图来自本地浏览器与隔离演示数据；访客 IP 使用文档保留网段，没有真实管理密钥和生产后台数据。多语言范围是文档，应用界面目前主要使用中文。
- 验证：215 项前端单元测试、1440 / 768 / 390 三尺寸共 45 项浏览器回归、生产构建与脚本体积检查通过；文档相对链接和锚点有效。
- 可提交源码复扫没有新增敏感内容发现；仍有 5 项已确认的测试假数据告警，不以忽略规则隐藏。

## 前端发布

- 入口：https://douxiaohu.duckdns.org
- 版本：`ui-20261117-153637-editorial`。
- 镜像：`sha256:45a8e0e96c6f1865310ba488ff8045d6f01598d89c61903ec93b6cfacc30fcee`。
- 发布包 SHA-256：`d8a8be1f61600d056a9c47ddabeab861885eb440306285d40af9e78aa2fa4434`。
- 备份：`/opt/backups/telegram-forwarder/ui-20261117-153637-editorial`。
- 回滚标签：`telegram-forwarder-ui-rollback:ui-20261117-153637-editorial`。
- 发布目录：`/opt/releases/telegram-forwarder/ui-20261117-153637-editorial`。
- 本地发布证据：`outputs/releases/ui-20261117-153637-editorial/`，不提交运行环境或配置值。

沿用[前次发布](2026-11-17-share-website-link-release.md)的前端镜像叠加流程，以该次实际源码清单为漂移校验基线。先备份，再在无网络、无宿主端口、独立临时数据库的容器中检查候选；旧 assets 保留，24 个新静态文件经过 HTTP 哈希核对。

这次线上只更新前端，后端二进制 SHA-256 仍为 `1cd1443ed055969c99a9b3f2b2d810fb526143d4a8ff10ae6fd914896a30927e`。运行环境、配置文件、挂载、来源公开权限和 `127.0.0.1:8000` 绑定均经核验。消息数量保持 5512 条，没有恢复旧数据库。

公网真实浏览器确认首页标题和页脚的新名称、管理登录标题，以及分享 PNG 中的「拾讯」和完整网站链接。抽检真实图片为 480 × 270，页面使用 contain；生成分享 PNG 为 1620 × 2151，没有图片加载失败提示或页面脚本错误。匿名管理 API 返回 401。

## 回滚

把上述回滚标签重新标记为 `telegram-forwarder_telegram-forwarder`，在 `/opt/telegram-forwarder` 下执行：

```bash
COMPOSE_API_VERSION=1.41 docker-compose \
  -f docker-compose.yml \
  -f /opt/releases/telegram-forwarder/ui-20261117-153637-editorial/runtime-preserve.json \
  up -d --no-build --force-recreate telegram-forwarder
```

保留当前数据库，不用发布前快照覆盖后续正常采集的消息。前端源码恢复时只恢复本次替换的文件，并先检查后来产生的改动。
