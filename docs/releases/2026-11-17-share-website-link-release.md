# 2026-11-17 分享卡片网站链接修正发布

状态：已上线，公网真实带图分享核验通过。

- 入口：https://douxiaohu.duckdns.org
- 版本：`ui-20261117-144050-editorial`
- 范围：每页分享 PNG 页脚加入完整公网网址，单页、多页、复制与 ZIP 导出均保留网站入口。地址不取本地预览 origin 或页面查询条件。
- 验证：生产构建通过；桌面、平板、手机共 12 项分享回归通过，包含多页图片逐页网址绘制次数校验。
- 公网核验：真实带图分享 PNG 为 1620×2151，网址已绘制到页脚，截图确认完整可见，无页面脚本错误。
- 镜像：`sha256:009f84a8741f6055d254b57fe7bdb0ca0bcada01282707225a2ba7582147b4d4`。
- 备份：`/opt/backups/telegram-forwarder/ui-20261117-144050-editorial`。
- 回滚标签：`telegram-forwarder-ui-rollback:ui-20261117-144050-editorial`。
- 发布与私有运行环境保存目录：`/opt/releases/telegram-forwarder/ui-20261117-144050-editorial`。
- 本地无凭据证据：`outputs/releases/ui-20261117-144050-editorial/`。

沿用[前一版发布](2026-11-17-editorial-ui-release.md)的前端镜像叠加、旧 assets 保留、隔离预验收和失败自动回滚流程。以前一版实际发布清单为源文件校验基线，无远端源码冲突；23 个静态文件经 HTTP 逐一校验。后端二进制、环境变量、来源权限和宿主回环端口均未变化，未触及 VPN 配置。上线核验消息数量保持 5511 条。

如需回滚，先将本版回滚标签重新标记为 `telegram-forwarder_telegram-forwarder`，然后使用 `COMPOSE_API_VERSION=1.41 docker-compose -f docker-compose.yml -f /opt/releases/telegram-forwarder/ui-20261117-144050-editorial/runtime-preserve.json up -d --no-build --force-recreate telegram-forwarder`。数据库保持当前版本，不恢复快照覆盖发布后的采集消息。
