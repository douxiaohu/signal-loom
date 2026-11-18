# Agent Note: 依赖分支整合与构建工具迁移

Status: implemented

## Problem

仓库最初有 10 个待合并 Dependabot PR，首轮合并后机器人又创建 3 个后续更新，同样纳入整合。仓库还有一个已合并的远端功能分支，另有三个已合并的本地分享分支。用户要求全部合入 main 并清理无用分支。单个更新分支基于不同时间的主干，部分 CI 仍使用已修复的旧扫描器；React 插件 6 与 Vite 6 不匹配，TypeScript 7 移除了 baseUrl，并加强了 CSS 副作用导入检查。

历史审计：[自部署与维护决定](../architecture/2026-11-17-signal-loom-maintainability.md)部分重叠，继续保留其权限、备份、公开配置和构建预算。本记录仅接管工具版本与分支整合流程，不改变阅读和管理 API。

## Decision

在临时整合分支依次合入原始 PR 提交，保留每个分支的祖先关系，再统一解决冲突和重建锁文件。main 接收经过本机和 GitHub 验证的完整结果；只删除提交已成为 main 祖先且没有独有内容的旧分支，不通过强制删除隐藏未合并工作。

前端采用 TypeScript 7、React 插件 6、Vite 8 与 jsdom 31。Vite 的配置使用 import.meta.dirname、rolldownOptions 和 codeSplitting.groups，维持 React 与按需二维码的独立模块。React 19.3 的运行时代码增长通过按需加载分享弹窗与图片查看器消化，保留原 280 KiB 阅读预算；弹窗与查看器分别设置 8 / 4 KiB 预算。加载中与失败状态都能通过关闭按钮或 Esc 退出，并恢复触发位置的焦点。后续 React、类型与测试库更新也纳入同一组回归。路径别名改成相对于 tsconfig 的 ./src/*，通过 vite/client 提供 CSS 导入类型。Node 支持范围与 jsdom 的要求一致：22.22.2+、24.15.0+ 或 26+ 的受支持版本范围。

浏览器 CI 在 build 完成后使用 preview 检查真正的生产分块，而不只检查开发服务；本地默认命令仍支持开发服务回归。GitHub Actions 统一使用新版组件，并补齐 setup-python。SQLite 使用 1.62.0，保留现有 schema 与迁移逻辑。后续非破坏性 npm/Go 更新分组，Actions 更新合并为一组；npm/Go 跨大版本更新仍单独审查，避免同时积累大量独立小更新分支。

picomatch 后续公告的临时源码修补与语法边界由[重复 extglob 修补决定](../bug-fix/2026-11-18-picomatch-redos-containment.md)维护，安全测试在前端应用测试之前执行。

## Alternatives considered

- 直接点击全部合并：步骤少，但不能解决 React 插件与构建器的配套关系，也不能证明组合结果通过测试，因此先在临时分支完成验证。
- 放弃失败的大版本 PR：可以减少兼容修改，但用户明确要求整合全部当前更新，因此补齐 Vite 8 和 TypeScript 7 配置。
- 放宽预算或忽略 peer dependencies：容易安装，但掩盖依赖不兼容或首屏体积变化，因此保持原预算并使用对应构建 API。

## Consequences

开发环境需要满足新的 Node 最低版本。锁文件按整合后的完整依赖重新生成，所有原 PR 提交保留在历史中。部署工具和站点业务逻辑保持原有边界；本次分支合并不自动重启生产服务。

验证包含 Go 竞态测试与静态检查、前端单元测试、生产构建预算、三尺寸浏览器回归、依赖与敏感内容检查，以及 GitHub 的 Linux/Docker/Python 3.8 和 3.12 检查。删除分支前再核对 main 祖先关系和 PR 合并状态。
