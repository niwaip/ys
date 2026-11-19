# 报告事实草稿（T13）

报告从已选择的评估快照生成，不依赖 Dashboard、Pi 或联网模型。首片固定模板只生成 draft；没有内部复核、AI生成、正式交付或自由事实编辑。

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

不得用“任意字符串+数字正则”替换该边界：无数字的文字也能伪造已修复/无风险结论。T14应提交受控段落并在校验失败时保留固定草稿；扩展解释/建议必须新增有事实类型和证据条件约束的模板，不能引入无来源修复结论。T15应另存新修订和操作审计，提交复核/通过/交付绑定明确revision和factHash；已交付版本不可被后续修改。T13没有公开叙述写入口，也没有正式输出入口。
