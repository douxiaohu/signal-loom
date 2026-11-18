# Agent Note: picomatch 重复 extglob 的拒绝策略

Status: implemented

## Problem

v2.0.0 版本准备的前端审计报告 GHSA-fc5q-39xc-vjpf。picomatch 4.0.7 的重复 extglob 分支分析遗漏单分支通配符，`+(*)`、`+(*a)` 等模式可生成指数回溯正则。2026-11-18 核查 npm 最新版仍为 4.0.7，GitHub 公告没有修复版本。Vite、Vitest、tinyglobby 与 fdir 都使用这一依赖。

历史审计：[依赖整合决定](../process/2026-11-17-dependency-branch-consolidation.md)部分重叠，保留其构建器组合、代码预算与生产预览测试策略；本记录接管 picomatch 的临时安全边界。[自部署决定](../architecture/2026-11-17-signal-loom-maintainability.md)部分重叠，保留发布校验与数据回滚边界。现有其他笔记没有重复 extglob 决定，无需归档或否决。

## Decision

仓库保留 npm picomatch 4.0.7 的 MIT 源码副本，标为本地版本 `4.0.7-signal-loom.1`，通过直接本地开发依赖与 `$picomatch` override 将全部调用方统一解析到它。包名保持 picomatch 便于追踪；没有将本地版本伪称为上游修复发行版。上游文件摘要、原始许可、补丁边界和移除条件随副本保存。Docker 在 npm ci 前复制这个本地包。

解析器的 extglobOpen 在生成正则前对 `plus` 和 `star` 类型抛出 `ERR_UNSAFE_EXTGLOB`。策略拒绝所有 `+(...)` 和 `*(...)`，包括原本安全的重复字面量；调用方不能用 maxExtglobRecursion 选项关闭它。普通星号、globstar、花括号、字符类以及其他 extglob 保持原行为。转义、引号保持上游行为，noextglob 继续禁用 extglob 解析。

安全测试通过子进程超时保护验证公告攻击样例、嵌套模式、相关选项及 parse/makeRe/posix 入口，验证普通源码 glob 和所有构建依赖的实际解析路径，并用摘要核对除了已审查 guard 之外的运行时代码。CI 在应用测试之前执行这一测试。npm audit 不扫描本地包内容，零告警不能证明本地修补有效，所以安全回归与摘要验证是独立门禁。

## Alternatives considered

- 等待上游正式修复：维护成本最低，但当前没有可安装的修复版，不能满足这次漏洞修复与发布要求；保留后续恢复上游的条件。
- npm audit fix --force：npm 建议降级测试工具，且公告影响所有旧版 picomatch，不能消除此漏洞，并会打乱刚验证的工具组合。
- 仅修正单分支判断并维持全部重复语法：兼容范围更大，但嵌套通配符、分支组合和后缀使正则安全证明复杂。当前源码 glob 不依赖重复 extglob，因此采用更窄、可验证的语法边界。
- 忽略公告或调低审计门槛：改动少，但没有修复正则风险，因此不采用。

## Consequences

使用重复 extglob 的新构建配置会显式失败，需要改成普通 glob 或其他受支持语法。补丁仅用于 Node 构建与测试，不进入 Go 服务与浏览器运行代码。上游有正式修复后，需审查其处理、移除本地依赖与 override，调整安全测试以验证修复后的兼容语法，并重新执行安全测试、应用测试、构建、浏览器回归及审计；不能只看到公告更新就删除限制。

本次发布在完整 CI 通过后合入 main，从最终发布提交构建带摘要的 Linux 制品，按现有工具备份、验证隔离候选再部署。回滚只恢复镜像和环境，保留当前数据库。
