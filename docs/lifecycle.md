# 生命周期资料与评估 v1

本功能只有人工 CSV 来源接入，不内置厂商日期，不自动抓取资料，不由 CVE 扫描生成 EOS/EOL。测试中的 Widget、来源地址和日期都是固定样例。

UTF-8 CSV（可含 BOM），逗号分隔，支持 RFC 4180 引号与 LF/CRLF；不猜分隔符。最多 500000 字节、1000 条记录，不允许 NUL。必须有全部表头：

```csv
source,sourceRef,product,version,eosStage,eosDate,eolStage,eolDate
人工收录的厂商公告,公告地址或文档编号,产品字面名称,明确版本,来源的销售终止阶段名称,2025-01-01,来源的支持终止阶段名称,
```

source/sourceRef/product/eosStage/eolStage 非空，最多500字符。version 可空。日期仅接受真实日历 YYYY-MM-DD；空日期是 unknown，无效日期是 invalid，原值保留。两个阶段独立处理：一个日期损坏不抹去另一个有效日期，也不拒绝整条资料。缺必需字段、结构损坏、空/重复表头或列数不符返回400且不建立批次。额外字段保留在 extensions，原文完整留存在 content。

阶段名称是来源定义；EOS/EOL 在本契约中分别为两个独立栏位，不能据缩写合并不同厂商的阶段。日期表示该来源所述阶段开始的日历日；按评估当日 UTC 日期分别返回 reached、future 或 unknown。已到日仅表示该日期已到，不证明客户已停止运行或产品受某个 CVE 影响。

## HTTP 与稳定读取边界

所有请求需 Bearer 操作员凭据、URL customerId 授权；对象、批次与评估均在该客户范围读取。未知/跨客户编号404，非法编号400，无凭据401，未授权客户403。请求 body 不允许 customerId。

| 请求（前缀 `/api/customers/:customerId/lifecycle`） | 行为 |
| --- | --- |
| POST `/batches` `{fileName,content}` | 201：直接原子保存有来源的 immutable lifecycle-csv-v1 批次及各行日期问题；不是资产 CSV 预览/提交流程 |
| GET `/batches` | 最近100批 `{items}`，不含原文，按 importedAt 降序、UUID排序 |
| GET `/batches/:id` | 完整原文、SHA-256、接入时间、来源行、阶段、问题 |
| POST `/assessments` `{batchId,assetIds}` | 明确选择1–1000个不重复客户资产，201：保存新的不可变评估 |
| GET `/assessments` | 最近100次 `{items}`，按 evaluatedAt 降序、UUID排序 |
| GET `/assessments/:id` | 回读固定输入、匹配及证据；不重新计算 |

相同客户/格式/精确 UTF-8 内容 SHA-256 复用原批次 ID，返回 replayed=true；改文件名不产生新批次。不同客户独立存储。新内容产生新批次，不修改历史。每次显式评估产生新的评估ID；新批次不自动替换历史评估。资料接入 importedAt、评估 evaluatedAt 和来源阶段 date 分别表达，不相互填补。

资产匹配输入是已保存资产的 attributes.product / attributes.version 字符串，去首尾空白；不从主机名、IP、产品名称中的数字推断版本，不执行范围或模糊匹配。product 和已知 version 同时字面相等为 exact，verification=verified 仅说明匹配核实，日期仍可能未知/无效。产品相等且任一版本缺失为 weak / needs_verification。双方版本均已知但不同、无相符产品或产品未知为 unmatched / unknown。多个来源行保持独立证据，不择优隐藏差异，不将弱匹配当作核实结论。页面明确显示匹配依据、输入来源及每个阶段的状态。

## Dashboard T12 / 报告 T13

共享 DTO 为 `packages/contracts/lifecycle.ts`，后端模块导出 `LifecycleService`（`getBatch(customer,id)`、`getAssessment(customer,id)`、`batches(customer)`、`assessments(customer)`）。读取必须先取得授权客户范围；服务 SQL 仍同时限制 customer_id。批次复用 T02 的 import_materials 证据存储和 transaction；资产导入历史仅列 format=csv，不混入生命周期资料。迁移8保存评估且以复合外键约束批次客户归属。

报告应绑定明确 assessment.id + batchId + contentHash + ruleVersion，不读取“最新”替换选定事实。每项 items 的 product/version、match/verification/basis 和 evidence（原始来源行/阶段/rawDate/dateStatus/status）是该次事实快照。Dashboard 必须明确选择评估版本，按对象身份去重，不累计历史次数；weak/unmatched、unknown/invalid 日期分别披露覆盖缺口。尚未评估不能当作无风险。生命周期证据不修改 CVE 判断，报告复核不修改生命周期事实。
