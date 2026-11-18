# YS · 客户资产风险工作台

按客户建立、查看主机资产的最小完整应用。React + Vite 前端、NestJS API、TypeScript 业务契约与 PostgreSQL 持久化按功能组织。当前实现人工主机建档与 CSV 清单预览/原子导入，不展示虚构扫描结果。

## 本地运行

使用 Node.js 24 LTS、npm。测试数据库不需要 Docker 或已有 PostgreSQL 服务。

```sh
npm ci
cp .env.example .env
# 编辑 .env：把 YS_OPERATORS 中的令牌占位符换成随机凭据
npm run dev
```

打开 http://127.0.0.1:5173 ，用刚配置的令牌进入工作台。前端通过 Vite 代理访问 3001 端口的 API。`.env` 仅供后端读取，不将凭据打包到前端。`.data/ys` 保存本地资料，应用和浏览器刷新后可回读；删除该目录会删除本地数据库。令牌只保存在当前标签页会话，可在页面退出。

生产 PostgreSQL 支持：将 `DATABASE_URL` 设置为独立数据库的 `postgresql://user:password@host:5432/ys`；运行账号需有建表权限。启动会执行版本化 SQL 迁移。`HOST` 默认仅本地；外部部署需由运维配置 TLS 终止、进程管理和数据库备份，本任务不部署。`npm run build` 生成 `dist/web`；部署时将 `/api` 转发给 `npm run start:api`，静态路由回退到 index.html。运行后端目前使用 tsx，无需独立打包。

`YS_CUSTOMERS` 为客户目录，`YS_OPERATORS` 为操作人员及允许访问的客户范围，均为 JSON 数组。启动校验重复客户、重复凭据和不存在的客户权限。修改配置后重启生效；移除客户不删除其历史数据库记录。该最小内部操作人员身份方案使用服务端配置 Bearer 凭据，没有客户自助登录或账号管理页面。真实凭据不提交仓库、不放 URL、不配置为 VITE 变量。

## 验证

```sh
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

API 测试通过真实 HTTP 边界使用临时 PGlite 数据目录，结束自动清理，覆盖重启持久化、客户权限、跨客户编号、同名独立、非法输入与分页。浏览器测试启动本地前后端，使用 `.data/browser-test` 和专用固定测试凭据验证登录、创建、刷新、切换。可使用已安装 Chrome：`PLAYWRIGHT_CHANNEL=chrome npm run test:browser`，不依赖额外浏览器下载。该凭据仅为隔离测试样例，不能配置到实际环境。浏览器测试端口 4173/3101；需要重新清空浏览器样例时先停进程，再删除 `.data/browser-test`。测试不会连接已有服务器或客户网络。

## 公开接口

请求需 `Authorization: Bearer <operator-token>`。所有客户范围由服务端配置校验；客户端不能通过伪造 customerId 扩大授权。

| 接口 | 行为 |
| --- | --- |
| GET /api/customers | 只返回该操作员授权客户与操作员显示名 |
| POST /api/customers/:customerId/assets | 创建主机，返回 201 与完整资产 |
| GET /api/customers/:customerId/assets?limit=50&offset=0 | 客户资产分页，limit 1–100，offset 0–1000000，按建档时间降序、UUID 排序 |
| GET /api/customers/:customerId/assets/:assetId | 读取同客户资产 |

创建内容示例：

```json
{"name":"生产数据库服务器","kind":"host","sourceRef":"CMDB-001","attributes":{"ip":"10.0.0.12","environment":"production"}}
```

仅 `name`、`kind` 必填；`attributes` 默认为对象，支持 JSON 扩展，名称会去首尾空白。系统分配 UUID、客户归属、manual 来源和建档时间。来源标识可缺失，名称及来源标识均不是系统身份；人工创建每次生成新记录，不隐式合并同名对象。未授权/未知客户返回 403，缺失或无效凭据 401，同客户下无资产或跨客户资产引用 404，非法内容/分页/编号 400，超出 1 MiB 请求限制 413。错误不会将查询退化为全局列表。

## 后续功能入口

- `packages/contracts`：仅共享业务输入输出与运行时校验，不共享数据库实体。
- `apps/api/src/assets`：资产模块和业务接口；其他功能增加自己的 Nest 功能模块，通过 `createApp(config, features)` 的 imports 或应用的静态 imports 挂载。
- `apps/api/src/auth`：OperatorGuard 验证身份及 URL 中 customerId 的权限。该 guard 在 CoreModule 中作为全局 guard 注册，新增功能默认也须认证；客户业务 URL 必须含 customerId，并在 SQL 中同时限定 customer_id 与对象编号；服务间调用同样需要已验证的客户范围。
- `apps/api/src/persistence/database.ts`：导出 DATABASE 注入令牌和参数化 query 接口。现提供串行 transaction 回调，普通 query 同样排队；只在回调内使用 session，不能跨异步请求直接拼接 BEGIN/COMMIT。迁移在 migrations 数组末尾追加版本，禁止修改已发布迁移。首片单进程启动，生产横向扩容前需加入迁移互斥。
- `apps/web/src/features.ts`：可组合页面注册，页面得到已授权客户上下文与 API 凭据；客户切换时重挂载页面，取消旧请求，避免旧资料留在新客户视图。

资产主数据选择及边界见 [ADR 001](docs/adr/001-local-asset-master.md)。

## CSV 资料导入

进入客户空间的“CSV 资料导入”，选择 UTF-8 CSV，检查映射及问题后整批提交。所有来源、采集时间、原始文本、SHA-256 与对象引用可从导入历史回读；问题记录不会显示为成功。输入示例、完整 HTTP 契约、整批事务及幂等规则见 [CSV 导入契约](docs/csv-import.md)，验证证据见 [T02 验证](docs/verification/t02.md)。

## 软件 SBOM

“软件 SBOM”页面建立软件对象、上传 CycloneDX JSON 1.4–1.6、查看独立输入版本、组件及原始资料。未知版本/生态明确提示，未执行扫描。支持范围、身份与历史规则、API 和后续 Trivy/容器接缝见 [SBOM 导入契约](docs/sbom-import.md)。

## Windows 采集 JSON

客户空间的“Windows 采集导入”接收本地 BAT 资料，保留原文、软件/KB/Build/UBR、来源完整性及未知字段。新内容生成独立快照，同名身份冲突保留待确认。支持范围、API 和后续评估读取边界见 [Windows 输入契约](docs/windows-import.md)。
