# 全栈架构审计与分阶段实施方案

> 范围：当前主干的 React 多入口、FastAPI、Telegram 采集、GitHub 排行、告警、SQLite、部署与验证。本文是方案，不实施运行时代码变更。既有设计约束见 `2026-08-13-modular-monolith.md`，本方案不改变单容器、单进程、单 SQLite 的默认部署。

## 结论与约束

当前已具备公开站 / GitHub / 管理台三个 Vite 入口、分离的 HTTP router、来源适配器接口、FeedService / SourceService、SQLite 连接工厂及安全边界。主要风险不是技术选型，而是**抽象已经出现，调用链却仍绕过抽象**。不建议现在拆微服务、换数据库或重写前端框架；先以垂直切片把现有边界真正接通。

保留合同：公开私有来源和媒体返回 404；管理员能查看历史孤儿消息；登录仍为单管理员，同源写入校验、HttpOnly / SameSite=Strict cookie 不退化；GitHub / 资讯 API JSON 与分页语义不变；调度器只在单 worker 启动；已有数据库增量迁移且不可删除历史 `delivery_*` 表。

## 现状与证据

| 范围 | 发现 | 影响 / 优先级 |
| --- | --- | --- |
| 持久化 | `app/storage.py` 约 2225 行，包含表创建、消息、来源、告警、访问记录及 GitHub 方法；`app/persistence/sqlite/connection.py` 目前仅封装连接 | 任一业务改表或 SQL 易影响别的域；P1 |
| 装配与路由 | `app/main.py:50-138` 同时创建服务、采集器、调度器和大量 `app.state` 属性；`app/admin_api.py:90-303` 路由直接读写 storage；创建来源还存在 `source_service` 缺失时回退直写 storage 的分支 | 服务边界可被绕开，测试替身与迁移难；P1 |
| 作业 | `app/jobs/runner.py:14-53` 已有 JobRunner，但 `app/main.py:118-119` 仍调用 `app/scheduler.py:80-111` 的另一套调度装配 | 双轨作业注册，后续新增任务易遗漏；P1 |
| 采集与来源 | `app/domain/feed/service.py:20-47` 将 external_id 强制转整数；`app/scheduler.py:16-77` 的 SourceCollector 特化公开 Telegram，Bot 另走 poller | RSS 等新来源不能直接复用当前消息模型；P2，须先迁移 schema |
| GitHub | `app/domain/insights/github/product.py:11-43` 是产品包装，但依赖 `SQLiteStorage` 和根目录 `github_service.py`，排行 SQL 仍在共享 storage | 第二个排行产品难以独立演进；P2 |
| 前端 | `frontend/src/features/*/index.ts` 只是重导出；`frontend/src/App.tsx` 约 434 行，集中管理管理台全部状态；`frontend/src/api.ts`、`public-api.ts`、`github-api.ts` 三套请求处理 | 入口隔离已有，模块内聚与错误策略尚未收敛；P1/P2 |
| API 成本 | `app/admin_api.py:69-95` 的 `source_to_dict` 对每个来源查询一次健康与全量 chat 统计；`admin_overview` 与 `operations_summary` 又各自重复组装 | 来源数增长后重复数据库访问；P2（先测量再优化） |
| 运行与安全 | `app/main.py:168-175` 优先采信 `X-Forwarded-For` / `X-Real-IP` 用于访问记录；`main.py:204-215` 在请求中同步写访问记录 | 代理头来源需明确可信代理边界；访问流量与 SQLite 写竞争需观测；P1/P2 |
| 验证基线 | 本次运行：后端 unittest 71 项中 1 项失败（`tests/test_github.py:78`：期望 stars_delta=25，实际 0）；前端 Vitest 8 文件中 4 个文件因 `window.localStorage` 未定义在收集阶段失败；`npm run build` 通过，raw JS 224971/256000 字节 | 先区分时钟/运行环境问题和产品缺陷，恢复稳定基线后才能安全重构；P0 |

> 上述失败是本机本次运行观察，不推断生产故障或永久缺陷。后端测试时钟相关性与 Vitest 的 Node/localStorage 环境需复现定位；不应为了让测试绿而改变产品逻辑。

## 目标结构与依赖规则

- `app/http/`：仅处理认证、请求验证、序列化、HTTP 错误；从 `AppContext` 获取用例，不直接执行业务 SQL。
- `app/domain/sources|feed|alerts|insights/github|visits/`：各自定义用例和所需 repository `Protocol`；不能反向 import FastAPI、SQLite 或别的域的具体实现。
- `app/ingest/`：来源抓取与解析；标准化项交给 FeedService，Bot offset / 采集 run 由对应持久化端口维护。
- `app/persistence/sqlite/`：按领域拆 repository、schema/migrations；共享同一 `ConnectionFactory`，跨表事务通过明确的事务边界处理，不要机械地把每个方法各开一次连接。
- `app/jobs/`：唯一任务注册/启动路径；手动触发与定时触发调用同一个用例及互斥机制。
- `frontend/src/features/{admin,public-feed,github-rankings}/`：每个 feature 收拢视图、hooks、API、类型、测试；`shared/` 只放真正跨业务的 HTTP、主题与通用组件。三个 HTML/Vite 入口保持不变。

依赖方向：HTTP/作业/抓取适配器 → 用例/端口 ← SQLite repository；前端页面 → feature hooks/API → shared HTTP。允许渐进迁移期的兼容 facade，但须给出删除节点，不保留两棵永久实现树。

## 分阶段执行（每阶段可单独合并与回滚）

### 0. 稳定基线与契约（P0）

1. 复现 GitHub 周期排行失败，检查快照测试的时间边界、时区和冻结时钟；复现前端 localStorage 在当前 Node/Vitest 组合下缺失的原因。
2. 固定可重复测试环境；增加公开权限、媒体、管理员孤儿消息、来源生命周期、会话/同源、排行与采集幂等的合同测试。建立失败归因记录，不绕过断言。
3. CI 按后端测试、前端测试、类型检查、生产构建、bundle budget 分独立作业；版本与运行矩阵以项目 manifest 为准。

**验收**：干净环境连续通过上述检查；已有 API 合同测试通过；任何已知未修复失败明确标为阻断项。回滚仅涉及测试/CI。

### 1. 后端装配与服务入口（P1）

1. 从 `main.py` 提取唯一应用装配函数；`AppContext` 成为依赖入口，移除业务路由对 `app.state.storage` 的直接调用及来源创建回退分支。按来源、资讯、告警、GitHub、访问统计逐个切片迁移。
2. 为各切片定义最小 repository Protocol，先保留旧 SQLiteStorage 作为适配器，避免一次性搬迁 SQL。
3. 合并两个调度注册路径到 `JobRunner` / `JobSpec`，保持任务 id、立即首次执行、`max_instances=1`、启动与关闭顺序及手动触发互斥语义；删去未使用路径。

**验收**：路由/作业不直接引用全能 storage；单 worker 下来源抓取和 GitHub 任务各只注册一次；启停无遗留任务；阶段 0 检查全绿。回滚按切片恢复旧装配，不动 schema。

### 2. SQLite 与业务边界（P1/P2）

1. 把来源、消息/FTS、告警、GitHub、访问统计的方法和 schema 增量迁移拆到对应 repository；同一连接/事务中的消息写入与告警匹配必须保持原子性。
2. 将来源健康与统计改成批量读取，避免逐来源重复查询；先记录查询数/耗时，优化后比较。
3. 引入有序、幂等 schema 版本迁移及备份/旧库升级测试；不删旧表、不重命名现有数据库文件。
4. GitHub 排名计算和采集编排各自归入产品模块，SQL 留在 GitHub repository；告警匹配由明确的用例/事务协调而非隐式存储副作用触发。

**验收**：现有真实旧库副本迁移成功且保留数据；插入/更新、FTS、告警命中、排行榜结果与迁移前合同一致；旧 facade 无调用后删除。回滚策略是先备份再部署，schema 变更默认只增不删。

### 3. 前端按业务收拢（P2）

1. 以管理台为起点把 `App.tsx` 中的资讯分页/轮询、来源操作、告警、访问记录、GitHub 状态拆为 feature hooks 和容器；保留 URL 状态、abort/请求序列与现有交互。
2. 合并网络层的凭证、错误、JSON 与 abort 处理；公共/API 管理鉴权行为保持差异。将领域类型及 API 移入 feature，跨入口共享仅抽真实复用项。
3. 对竞态、401、筛选回退、分页去重、操作失败和主题持久化增加组件测试；跑多入口 E2E。

**验收**：三个入口体验/路由不变，Vitest、E2E、`tsc`、build 和 bundle budget 通过；不新增无必要的全局状态库。回滚按单个 feature 进行。

### 4. 扩展能力与运维（按需求启动，P3）

- 若明确需要 RSS：先设计 `external_id TEXT`、唯一约束/回填和迁移，再实现 adapter、管理表单与展示规则；不能直接复用整数 `message_id`。
- 若明确需要新洞察产品：独立表、配置、repository、任务、路由、前端入口和测试，不向 GitHub/Telegram 表加类型列。
- 若需多 worker 或数据库迁移：先解决会话持久化、任务单实例/分布式互斥和写入模型；没有这一前提保持单 worker。
- 观测：结构化任务 run 日志/失败率、采集时延、SQLite busy 次数、查询耗时；明确可信代理配置再处理真实访客 IP，访问统计写入失败不影响页面。

## 建议的实施顺序与停止条件

先完成阶段 0，再以「一个可见业务切片 + 其测试 + 可回滚改动」推进阶段 1–3。每次合并前运行 ` .venv/bin/python -m unittest discover -s tests -q`、前端目录中的 `npm run test` 和 `npm run build`，并针对变更跑相关 Playwright 用例。若任一步带来 API/权限合同变化或不可解释的数据迁移差异，停止重构、恢复上一切片，而不是继续大规模搬文件。
