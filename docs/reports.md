# 报告事实草稿（T13）

报告从已选择的评估快照生成，不依赖 Dashboard、Pi 或联网模型。T13固定模板先生成draft；T15内部复核与正式HTML流程见下，仍不提供自由事实编辑。

## HTTP

沿用 Bearer 操作员凭据和 URL customerId 授权；所有引用通过客户范围服务读取，跨客户报告或依据404，未授权客户403，无凭据401，非法编号/请求400。

| 接口（前缀 `/api/customers/:customerId/reports`） | 行为 |
| --- | --- |
| POST `/` `{assessmentRefs?:uuid[],lifecycleRefs?:uuid[]}` | 201，新报告及修订1；合计1–20个明确评估ID，不接受客户端 facts、narrative、customerId 或“最新”标记 |
| GET `/` | `{items}`，最近100份摘要，按创建时间降序、UUID排序，不加载事实正文 |
| GET `/:reportId` | 报告及当前修订的固定事实、来源、统计、受控段落、事实SHA-256 |
| GET `/:reportId/preview` | `text/html` 草稿预览，明确未复核；不是正式交付输出 |
| GET `/:reportId/revisions/:revisionId` | 同客户、同报告下明确修订的固定事实 |
| GET `/:reportId/revisions/:revisionId/preview` | 固定修订HTML，不依赖后续当前修订选择 |

CVE来源支持T05软件、T06容器镜像与T07 Windows证据评估，按target.kind使用独立读取适配器。容器保留镜像身份及明确输入版本，不证明运行实例。Windows保留采集快照、规则资料ID/hash、规则来源和offline_curated_rules模式；覆盖保持partial，不能声称完整厂商feed。适用性分布独立列出，confirmedAffectedCount只计affected条目；fixed、unknown、potentially_affected和tool_reported均不计入该确认数，也不因此宣称无风险。

CVE引用必须是终态任务。queued/running 返回409，避免把尚在变化的任务当作固定评估。失败、工具不可用、超时、中断可以纳入事实，但明确没有可用结果。一个软件对象输入版本每类评估只能选择一次；累计同对象同版本的多个CVE或生命周期历史返回409，不隐式挑选“最新”或叠加历史。不同对象/明确输入版本可同时纳入范围。引用重复、空引用及超限400。相同请求再次提交明确生成新报告，首片无报告生成幂等键。

报告完整复制所选评估事实及其引用，并记录输入资料哈希、接入时间、来源采集时间、评估时间、工具/规则版本。生命周期CSV没有来源采集时间时保持null。报告生成时间不填补未知时间/阶段日期。新评估、新来源批次或后端重启不会改变既有草稿。事实对象按键排序后以UTF-8 JSON计算SHA-256；渲染前再次核验，拒绝事实偏移。

## 统计和覆盖

- findingInstances 是所选可用评估结果中的结果条目数（含Windows规则的fixed/unknown等状态），保留未关联组件的工具条目；不是确认受影响客户资产数。
- uniqueCveCount 仅按符合 `CVE-YYYY-NNNN…` 的标识去重。非CVE漏洞标识仍逐条展示并计入工具发现，不冒充CVE数。
- severityCounts 为工具发现条目的严重程度原值分布，不是风险评分。库新鲜度、覆盖状态与发现条目分别呈现。
- 没有可用CVE结果时发现数/CVE数为null（未知），不显示为0；有部分可用结果时只统计已返回条目，同时披露失败/缺失范围。
- 生命周期 exact/weak/unmatched 分开统计；未选择生命周期资料时这些统计为null。阶段日期、原值、日期状态和来源分别保留，坏日期或未知日期不会以导入/评估时间填补。
- 所选范围中未有CVE或生命周期引用的对象明确显示未评估。两个类别始终保留独立章节，弱匹配/未知不能降为无风险。

前端只列最近100次可选评估，使用明确ID选择；queued/running不可选。草稿通过无脚本sandbox iframe预览，依据明细通过带凭据的客户范围API读取。HTML对来源文本转义，并设置限制脚本与外部资源的CSP。

## T14 / T15稳定边界

共享DTO：`packages/contracts/reports.ts`。`ReportsModule.register(assessmentsModule)` 与应用使用同一个动态评估模块实例，不注册第二个任务worker。导出 `ReportsService.create/get/list/getRevision/preview/previewRevision`。未来调用方仍需先取得授权客户范围。

`apps/api/src/reports/render.ts` 导出 `hashFacts`、`defaultNarrative`、`validateNarrative`、`renderReport`。ReportRevision绑定完整facts与factHash，另存 `controlled-paragraphs-v1` 叙述：

```json
{"schemaVersion":"controlled-paragraphs-v1","density":"standard","blocks":[{"templateId":"scope","wording":"standard"},{"templateId":"assessment","factRef":"<selected-assessment-id>","wording":"concise"},{"templateId":"lifecycle","wording":"standard"},{"templateId":"coverage","wording":"standard"},{"templateId":"evidence","wording":"standard"}]}
```

模板固定为 scope/assessment/lifecycle/coverage/evidence。每份所选评估有一个保护段落；缺少某类资料时该类别使用无factRef的未评估段落。校验要求所有原有段落及引用恰好出现一次，不允许删除覆盖/证据、重复、引用其他事实或注入额外字段。允许排序、standard/concise措辞和standard/compact密度；版本、数字、标识、日期、判定均由renderer插入，模型/复核不提供这些值。

不得用“任意字符串+数字正则”替换该边界：无数字的文字也能伪造已修复/无风险结论。T14应提交受控段落并在校验失败时保留固定草稿；扩展解释/建议必须新增有事实类型和证据条件约束的模板，不能引入无来源修复结论。T15应另存新修订和操作审计，提交复核/通过/交付绑定明确revision和factHash；已交付版本不可被后续修改。T13创建入口没有公开事实写入；T15的受控修订及正式输出入口见下。

## T15：内部复核、修订与正式HTML

在同一事实契约上，报告支持 `draft → in_review → approved → delivered`。提交、通过与交付只能流转当前修订，并按该顺序执行；禁止直接通过草稿或交付未通过版本。原评估和事实hash不改变。当前采用已有内部操作员权限：具有该客户访问权限的操作员可以编辑、提交、复核与交付；未宣称已有独立复核角色或双人隔离制度。

| 接口（报告前缀 `/:reportId`） | 行为 |
| --- | --- |
| POST `/revisions` `{baseRevisionId,narrative}` | 新草稿修订，保护事实由服务端复制；允许受控文字/段落/措辞/密度，不接受facts；基于过期修订409 |
| GET `/revisions` | 同客户报告的修订历史，按修订号升序 |
| POST `/revisions/:revisionId/submit-review` `{}` | draft→in_review，记录提交人/时间 |
| POST `/revisions/:revisionId/approve` `{}` | in_review→approved，记录复核人/时间 |
| POST `/revisions/:revisionId/deliver` `{}` | approved→delivered，保存固定HTML字节、SHA-256、事实hash、交付人/时间；重复已交付修订返回原交付元数据并replayed=true |
| GET `/revisions/:revisionId/export` | 仅正式交付修订，返回可独立查看的HTML附件；未交付409；字节hash和事实hash校验失败拒绝输出 |
| GET `/audit` | 该客户报告的提交、通过、交付与编辑事件，包含修订ID、操作员显示名及凭据不可逆hash身份、时间及事实hash引用；不保存访问令牌 |

编辑已通过或已交付内容仍生成新draft，需要重新提交及复核；原修订内容和已存交付字节保持不变。修订的事实/叙述创建后不改写，状态/流转元数据由服务端更新并另存审计事件；旧报告最初创建者/创建时间保留在报告记录，页面同时展示建档信息。报告行锁串行化同报告操作，防止并发新修订覆盖和重复交付。交付保存与状态、审计处于同一数据库事务。

HTML已在本片明确为首个正式交付格式，不调用外部转换器。下载请求在授权API取得文件，访问令牌不进入URL或交付文件；正文为转义后的保护事实和受控段落，独立HTML不运行脚本、加载外部素材。预览与正式输出使用同一renderer和完整性验证，正式文件标记已内部复核，保留范围/来源/未知/覆盖缺口、复核及交付时间。Word/Excel/PDF未扩展。

`ReportReviewService` 导出 `revise/transition/history/audits/export`，T14经过校验的AI段落应调用同一 `revise(customer,reportId,baseRevisionId,narrative,operator)`，不能直接改DB事实或覆盖当前修订。异步生成期间已有新修订时409，调用方保留诊断而非覆盖。所有服务调用前仍需已授权客户上下文。未来新增受控模板必须保持事实引用完整性与同一复核状态机。

## T14：受控AI提案

固定草稿、内部复核与正式交付均可独立使用。可选AI任务绑定明确baseRevision/factHash，模型组织保护段落及引用绑定的文字；成功仍生成新draft，失败保留原稿。summary/recommendations为最多各一个的受控可选模板，保护正文由服务端生成；text 接受下述有限中文句法文字，插值绑定事实。任务API、工具/脚本/skill及本地假Pi验证见 [报告AI叙述](report-narration.md)。


## 受控文字通道

`ReportBlock.text?: string`（最多4000字符）是 AI 和人员共用的实际文字字段；原有无 text 修订保持兼容，事实hash与评估不变。页面每段有文字输入框，并展示本报告可用引用、允许说明与句法目录。输入可以组合、重排多句，也可改连接词、说明短语、动作与目的；保存后服务端解析并形成新draft，必须重新复核。保护事实正文始终保留。

语法与引用唯一实现为 `packages/contracts/report-language.ts`：说明句为 `<围绕|针对|结合>【token】，<该引用允许的说明短语>。`；建议句为 `<因此，|接下来，|空>建议<目录动作>，以便<目录目的>。`。例如：

```
结合【coverage】，这些缺口限制结果解释，需补充证据后复评。因此，建议补充覆盖资料，以便完善后续评估输入。
```

服务器从绑定的完整事实生成引用目录并插值，模型或人员无法提供替代值。scope展开明确对象与输入身份；findings仅在结果数已知时存在；coverage仅在覆盖缺口非空时存在；assessment/lifecycle引用仅包含该报告已选评估。每个引用列出可用解释，覆盖解释只能搭配coverage，发现解释只能搭配findings；补充覆盖建议须先引用coverage，其他保守核查建议须先有引用说明句。未知引用、无依据组合、额外数字/日期/判定、未列入语法的文字或HTML都会拒绝，并返回具体原因。

这是有限语言的完整语法与证据条件校验，不声称能验证任意自然语言语义。当前可表达所选输入、发现的解读限制、覆盖缺口影响及后续核查建议；扩展词法或事实解释时应增加明确证据条件和接口行为测试。不能以去掉数字的正则过滤冒充事实校验。
