# Windows Server 2022 补丁证据评估

首片支持范围在实现前由 T07 调度明确为 **Windows Server 2022 LTSC、Build 分支 20348、x64**。不包括 Server 2022 23H2/25398、其他 Windows 产品线或任意同名产品。复用 T03 固定主机快照和 T05 持久任务表/任务接口；没有远程采集、扫描、安装补丁或联网取库。

## 规则资料与来源

本功能接收操作人员整理并核实的有限公告 JSON，**不内置完整/最新 Microsoft Windows feed**。每份规则是不可变资料，保存精确上传原文、SHA-256、导入时间、规则版本及来源。`sources[].content` 可以是明确整理保留的来源正文或相关证据摘录，`sha256` 必须为该 UTF-8 字符串的 SHA-256。它不是 CVRF 整份文档哈希，除非确实上传完整文档内容。来源 URL 必须是 HTTPS，主机为 `msrc.microsoft.com`、`api.msrc.microsoft.com` 或 `support.microsoft.com`，无用户名密码；不发出网络请求。系统核对内容哈希与字段结构，但不会保证上传内容真实来自该 URL；结果保留 `verifiedOnline:false`，页面明确告知操作员核实真实性。

输入形状如下（示例是结构说明，省略的正文和哈希必须替换为真实资料，不能直接提交）：

```json
{
  "schemaVersion":"1", "ruleVersion":"curated-2026-11-19",
  "product":"Windows Server 2022", "branch":20348, "architecture":"x64",
  "scope":"本批次只覆盖操作人员核实的指定公告",
  "sources":[{"id":"msrc-advisory","url":"https://msrc.microsoft.com/update-guide/vulnerability/CVE-2024-38063","retrievedAt":"2026-11-18T00:00:00Z","content":"实际保留的来源正文/证据摘录","sha256":"该内容的64位小写十六进制SHA256"}],
  "advisories":[{"cve":"CVE-2024-38063","severity":"CRITICAL","fixedUbr":2700,"fixedKbs":["KB5042881"],"affectedBeforeFixed":true,"sourceIds":["msrc-advisory"]}],
  "supersedence":[]
}
```

- `affectedBeforeFixed` 是来源明确支持“该产品分支中低于修复 Build 的构建受影响”的声明，不能仅因 KB 清单中没有编号就填写 true。false 时较低构建最多为可能受影响。
- `supersedence` 每条 `{supersededKb,replacementKb,sourceIds}` 必须由同一产品、分支和架构的来源证据支持。规则资料整体限定产品分支，不允许跨分支边。路径按显式有向边遍历，有访问集合防环；**不比较 KB 数字大小**。
- 公告 CVE 及来源 ID 各自必须唯一；所有 sourceIds 必须存在；公告及每条替代边必须引用至少一份来源。
- 最多 500000 UTF-8 字节，JSON body 沿用 1 MiB 总限制，不含 NUL；schemaVersion 仅 `1`；每份 1–1000 条公告、0–1000 条边、1–100 份来源；单来源正文最多 200000 字符。无效哈希/格式/来源引用返回 400，不落库。
- `tests/fixtures/windows/rules.json` 是明确标记 **synthetic-test-1** 的合成测试资料。特别是替代 KB5040000 是人为构造，用于证明不按数字大小判断，不能作为实际 Microsoft 公告/替代关系使用。页面不会默认装载该文件，生产数据需要独立上传。

来源研究记录（未由本实现重新联网验证）：2026-11-18 抓取的 MSRC `2024-Aug` CVRF 文档哈希为 `0140e894ecfbb4c8d37c2ffb6b1e8bb91b5c55cf5e41bc448ac383cf0ccc5d0e`，研究指出当前文档中 CVE-2024-38063 对产品11923/11924列出 KB5042881 / 20348.2700，替代5041160。CVRF 月份标签不保证文档不可变，不能把上述关系冒称为原始2024年8月快照。此记录用于指导人工核实，不被自动载入引擎。

## 判定规则

产品名称只接受 `Windows Server 2022`，允许 Microsoft 前缀、Standard/Datacenter 及其 Evaluation 后缀；Build 必须精确字符串 `20348`，架构接受 x64/amd64/64-bit。其他或未知产品/分支/架构返回未知，不进行跨分支数值比较。提供 FullBuild 时只接受 20348.UBR 或 10.0.20348.UBR，并要求与 OSBuild/已知 UBR 一致；冲突或未知格式保持未知。

完成修复确认还必须同时具备：采集时间已知；来源 Overall 为 COMPLETE/SUCCESS/SUCCEEDED；没有 FAILED/PARTIAL 子状态；KB 清单存在（可以明确为空）；KBInventoryComplete=true；RebootPending=false。缺失重启状态保持未知，不能当作 false；部分或失败采集不确认 fixed。

| 适用性 | 来源与主机证据 |
| --- | --- |
| fixed 已修复 | 产品/分支匹配且采集满足上述条件；已安装公告固定 KB、沿显式同分支边安装替代 KB，或 UBR 达到来源修复阈值 |
| affected 受影响 | 同产品/分支、完整证据、UBR 低于修复值、没有已证明修复 KB，且公告明确 affectedBeforeFixed=true；不是仅按缺少 KB 判定 |
| potentially_affected 可能受影响 | 同产品/分支有较低 UBR，但缺少完整证据或公告没有明确低构建受影响范围 |
| unknown 未知 | 产品/分支/架构未知、缺少可判定版本，或已有修复候选但完整性/重启状态不足等 |

UBR=0 是已知有效值；无 UBR 不能做构建比较，但完整采集的精确 KB/有来源替代链可以独立支持修复。严重程度与适用性分开；fixed、unknown、potentially_affected 不自动计入已确认受影响。每条保留 observed Build/UBR/KB/来源状态、fixedKbs、matchedKb、supersedencePath、sourceIds 和判定依据。始终 `coverage.status=partial`，说明仅覆盖上传规则；源时间与执行时间分别保存，freshness=unknown，不声称最新或零漏洞。

## 接口、任务与固定历史

所有请求使用 Bearer 操作员凭据，后端客户 URL 权限与 SQL 范围同时校验，body 不允许覆盖客户。

| 请求 | 行为 |
| --- | --- |
| POST `/api/customers/:customerId/windows/rules` | `{fileName,content}`；201，保存原始规则资料，按客户+格式+内容哈希幂等 |
| GET `/api/customers/:customerId/windows/rules` | 最近100份规则摘要与来源元数据，不加载原文/来源正文 |
| GET `/api/customers/:customerId/windows/rules/:ruleId` | 精确规则原文、来源正文和解析资料 |
| POST `/api/customers/:customerId/assessments` | `{snapshotId,ruleImportId,idempotencyKey}`；202，持久排队 |
| GET `/api/customers/:customerId/assessments?targetKind=windows&limit=50&offset=0` | 共用任务分页摘要；findingCount 是公告判定行数，不能直接当作受影响漏洞数 |
| GET `/api/customers/:customerId/assessments/:id` | 共用固定任务、结果及证据回读 |

排队任务绑定 snapshotId、assetId、主机原始 importId/contentHash 和规则 ruleImportId/ruleHash，不随新资料改变。一次执行保存工具 `ys-windows-evidence/1`、解析 `windows-evidence-v1`、输入适配器版本、规则版本、规则来源时间/URL/哈希、开始结束时间、结果哈希。规则资料/主机原文在执行时再次核对哈希。

复用 `vulnerability_jobs` 表，不增加迁移。Windows worker 仅领取 windows；Trivy worker 仅领取 software/container。queued → running → succeeded/failed；启动把自身遗留 running 标记 interrupted，恢复 queued，不自动重试终态。单后端进程假设与 T05 相同。浏览器关闭不取消任务。相同客户/幂等键/输入快照/规则返回同任务；其他输入或跨目标类型同键为409；新评估需新键。未认证401、未授权客户403、跨客户/不存在快照或规则/任务404、无效输入400。

## 消费者契约

`packages/contracts/windows-assessments.ts` 提供 `WindowsAssessment`。共享 `AssessmentService.get/list` 返回 `AnyAssessment` / `AnyAssessmentPage`（Trivy Assessment 或 WindowsAssessment）。报告/Dashboard 必须先按 target.kind 区分：windows 的 `result.findings` 含每条公告的四态判定，不是全为软件漏洞。确认影响只统计 applicability=affected，其余分别披露。源规则 scope、coverage/issues 和固定 snapshot/rule哈希必须随报告保留，不能省略为“扫描完成”。页面按 targetKind 过滤，软件页不会把 Windows 历史当作软件任务展示。

下游通过同一个 `AssessmentsModule.register()` 导出的 AssessmentService 读取；勿重复注册worker。规则原文可由 `WindowsAssessmentService.getRules(customerId,ruleImportId)` 或相应 HTTP 接口获取。T03 WindowsService.getSnapshot 继续作为固定主机输入边界。
