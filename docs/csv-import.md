# CSV 资产清单输入与提交契约

仅主机清单，UTF-8（允许 BOM），逗号分隔，LF 或 CRLF。双引号字段可包含逗号、换行，内部引号用 `""` 转义；不自动猜分隔符或字段含义。表头大小写敏感，去首尾空白，不得为空或重复。最多 500000 UTF-8 字节、1000 条数据记录；不允许 NUL。JSON 请求总体沿用 1 MiB 限制。

```csv
source,sourceRef,name,kind,collectedAt,ip,environment
cmdb,host-001,生产数据库,host,2026-11-01T10:00:00+08:00,10.0.0.12,production
cmdb,host-002,批处理服务器,host,,10.0.0.13,batch
```

- 必填 `source`（1–200 字符，来源命名空间）、`sourceRef`（1–500，来源提供的稳定对象编号）、`name`（1–200）、`kind`（仅 `host`）。这四项去首尾空白。任何缺失都不会由 AI 或文件名补全。
- `collectedAt` 可空，非空必须为真实日历日期、含时分秒与时区的 ISO 时间；规范化为 UTC。缺失保持 null / 未知，不用上传时间补齐。
- 所有额外表头原样映射到 `attributes.<表头>`，值为原字符串，不推断类型，不丢弃来源特有内容。预览展示所有映射。
- 系统对象 UUID 与来源身份分开。导入对象身份为客户 + source + kind + sourceRef；同名、同 IP 不隐式合并。人工记录保持 T01 原有独立身份语义，不参与导入去重。
- 原始 CSV 是 API 收到的精确 UTF-8 文本（页面严格 UTF-8 解码且保留 BOM）；SHA-256 对该文本 UTF-8 字节计算。文件名是元数据，不参与内容身份。

## 公开 API

沿用 `Authorization: Bearer <operator-token>`，服务端验证 URL 客户权限。所有资料、对象、提交查询都同时限定客户与编号。以下返回正文中的资料结构为共享 `ImportMaterial`；预览/详情含原始 content，历史不加载 content。

| 请求 | 行为 |
| --- | --- |
| POST `/api/customers/:customerId/imports/csv/preview` | JSON `{fileName,content}`；201，持久保存并返回映射、每条问题、canCommit、policy=atomic、原始资料编号/内容哈希/接入时间 |
| POST `/api/customers/:customerId/imports/:importId/commit` | 201，返回已提交对象编号与 committedAt；重复已提交资料返回相同结果并标记 replayed=true |
| GET `/api/customers/:customerId/imports/:importId` | 200，读取原始资料、处理状态、映射、每行对象引用 |
| GET `/api/customers/:customerId/imports` | 200，`{items}`，按接入时间降序/UUID 排序，最近 100 份，列表不含 content |

## 原子性、重复与失败

采用整批提交，不支持只选有效行。预览不建立资产；所有记录为 ready 才能提交。缺失字段、无效日期、不同列数、同批重复或歧义均使整批 canCommit=false，问题行显示 invalid 或 duplicate；409 提交不会创建任何对象。坏引号、重复/空表头、空资料及超限输入在解析前后返回 400，不建立预览资料。

相同客户、格式与原始内容哈希返回同一资料编号，`replayed=true`，包括已提交资料；改文件名不会重新建资产。同一内容上传到不同客户，资料和资产保持独立。不同内容若含已有来源对象，预览显示 duplicate，阻止整批，不静默更新旧对象；修改来源资料后需重新上传。当前不提供更新既有导入对象的快照操作。

提交时再次通过唯一约束核验来源身份。预览后的并发变化也可能导致 409，整个事务回滚，保留原预览及原始资料供核查。UI 明确显示服务器冲突信息，用户修正/排除冲突对象后重新上传。相同资料重复提交返回同一对象引用，不重复创建；资料处理行只有事务成功后才变为 imported。`importedAt` 是原始资料接入时间，`committedAt` 是资产整批提交时间，资产 `createdAt` 是建档时间，行及资产的 `collectedAt` 是来源采集时间。

无效凭据 401、未授权或未知客户 403、跨客户/不存在资料 404、非法编号 400。不得通过请求 body 添加 customerId 改变归属。

## 复用边界

`import_materials` 保存客户/格式/文件名/原始内容/内容哈希/资料接入时间/JSON 处理结果，按客户+格式+哈希唯一；资产 `importId` 的复合外键约束同客户来源，行级处理结果保存 row→assetId。后续格式可复用此资料存储结构，自己的解析与业务校验放各自功能模块，不把 SBOM/工具输出冒充 CSV。

`Database.transaction(async session => ...)` 提供公共原子操作边界；普通 query 也在同一队列排队，避免插进他人的 BEGIN/COMMIT。只在回调内使用传入 `Queryable`，不调用外层 db、不嵌套事务、不把 session 暴露到回调外；工具调用在事务外执行。`ImportsService` 提供客户范围的资料读取、历史、CSV 预览与提交，不导出解析实现到浏览器。

迁移继续注册于 `database.ts`，按 version 数字升序执行，不依赖数组插入顺序。票号保留首迁移号（T02=2、T03=3、T04=4、T08=8），后续同票迁移用票号×100+序号（例如 T03 下一条为 301）；不创建空占位，不修改已发布 SQL。后续新增迁移不能依赖数值比它更大的其他票迁移。
