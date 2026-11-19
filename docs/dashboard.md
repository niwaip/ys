# 客户风险概览 v1

T12 是客户范围只读聚合，不创建扫描、评估或风险分数。按组合→对象→固定输入版本/快照→评估→证据逐层查看。没有全客户合并视图；报告复核、文字编辑和导出不参与计算。

## 当前与选择规则

- 软件默认复用 T11 `SoftwareHistoryService.current(customerId,softwareId)` 的显式指针。current=null，或指针只有 versionId 而 assessmentId=null 时，评估保持未选择；组件数可由已选 SBOM 输入取得，但不会从最近成功任务补齐风险。上传或重扫不改变指针。
- 容器和 Windows 暂无 current 指针，必须显式选择固定 assessmentId。没有选择时显示未知/未选择，不把所有历史任务累加。
- 通过 `assessmentRefs` 可以显式覆盖某个对象的软件 current，也可选择容器或 Windows 批次。每个对象最多一个；同对象多个历史批次返回400。批次对应的 versionId/snapshotId 决定所有版本事实，不自动读取最新。
- 可限制为一个客户对象，并用含时区 ISO 时间限制评估 createdAt。选定CVE批次的createdAt及生命周期评估的evaluatedAt分别受同一时间范围限制；范围外显示 outside_time_range，不纳入状态统计，不回退另一次评估。
- EOS/EOL 必须明确 `lifecycleAssessmentId`，无选择为未知，不默认最近批次。软件只采用与所选 versionId 相同的生命周期输入；主机生命周期来自独立资产属性快照，若不能关联所选 Windows snapshotId，保持该快照的生命周期未知。容器的生命周期输入尚未支持，披露未知。

## 统计单位

| 字段 | 单位与边界 |
| --- | --- |
| catalog.inventory | 客户全目录 SQL count，分别为主机、软件对象和镜像对象；不等于当前评估范围 |
| metrics.inventory | 当前概览范围内对象数；Windows资产归入host，人工主机没有评估也保留 |
| components.known | 所选软件/镜像输入 SBOM 组件行数；不跨版本累加。unknownObjects 同时说明尚未选输入的对象 |
| objects[].installedSoftwareCount | Windows已安装软件清单行数，与SBOM组件分开；缺失为null |
| cve.uniqueCves | 可用结果中符合 CVE-年-数字 的唯一 CVE（大小写归一）；GHSA/工具其他标识不冒充 CVE |
| cve.uniqueObserved | 可用结果中的唯一公告/工具漏洞标识，含非CVE标识；不是风险数 |
| cve.instances | 所选固定结果的观测行数；相同CVE在多个组件/目标中的实例保留 |
| cve.confirmedAffectedObjects | **只数 Windows applicability=affected 的不同主机**。没有可用Windows结果为null；tool_reported不计确认影响 |
| cve.toolReportedObjects | 含Trivy tool_reported候选行的对象；不自动等同资产确认受影响 |
| cve.bySeverity / byApplicability | 观测行分布。Windows fixed/unknown也为观测行，不能据严重程度分布当作风险数 |
| coverage | 选定、成功、失败/不可用/超时/中断、等待/执行、未选择、时间范围外，以及完整/部分/未知分别统计 |
| freshness | 沿用固定评估库时间fresh/stale/unknown；采集时间另列，缺失不以导入或评估时间代替 |
| lifecycle.eos / eol | 当前对象范围内分别计reached/future/unknown/conflicting；只对exact+verified匹配认已知阶段。来源不同阶段状态冲突保留conflicting，不择优隐藏 |
| trend.total | 当前趋势范围真实历史批次数，SQL count；不是唯一CVE数、实例数或风险对象数 |

没有可用成功结果时，CVE数为null，不显示成零风险。工具成功但coverage未知时，0只代表该结果未观测到行，覆盖缺口继续显示。Windows fixed不进入确认影响数；低覆盖、未知、失败及未选择不表示安全。

## 趋势与下钻

默认 `trendMode=selected_inputs`，只展示当前概览已选输入的历史任务；显式选择 `object_history` 才对照相同对象所有输入版本。图表是逐批次趋势表，每点保留固定批次/输入、状态、独立观测行与唯一标识、覆盖、库时间、inputChanged/coverageChanged，不累加历史。

只有相同输入、成功、完整覆盖、工具版本已知一致且已知库时间上下文一致时，才允许对照观测。仍不把“后一次未出现”称为已修复。输入变化、覆盖下降、失败或范围退出都不能成为风险修复证据。范围外不提供伪造趋势点。

页面对象明细直接使用本次view返回的固定对象行；观测明细分页使用已解析 `scope.assessmentRefs` 与相同 from/to，不重新读取current指针。因此当前指针后来改变不会把已展示统计的下钻改到另一份评估。明细可进一步读取所绑定的任务原始证据；生命周期来源批次、输入哈希与阶段证据独立回读。

## HTTP 与上限

所有请求沿用Bearer及后端customerId权限，所有查询同时限定客户。不存在/跨客户对象、任务、生命周期引用404；未认证401；未授权客户403；错误范围/重复对象批次/分页400。不接受body customerId。

| 接口 | 行为 |
| --- | --- |
| GET `/api/customers/:customerId/dashboard/catalog?limit=100&offset=0` | SQL总数及对象分页，limit1–1000/offset0–1000000；对象页不冒充客户总数；评估选择目录最近1000条并用truncated披露；生命周期选择目录最近100次 |
| POST `/api/customers/:customerId/dashboard/view` | `{assessmentRefs?:uuid[],object?:{kind:host\|software\|container,id},lifecycleAssessmentId?,from?,to?,trendMode?:selected_inputs\|object_history}`；200，同一scope指标、对象行、趋势、警告及scope hash |
| POST `/api/customers/:customerId/dashboard/findings` | `{assessmentRefs,from?,to?,limit?:20,offset?:0}`；200，固定结果实例分页 `{items,total,limit,offset,assessmentRefs,from,to}`；limit1–100 |

概览最多1000个对象；超限明确400，要求通过分页目录缩小到单对象，不截断后返回假总计。assessmentRefs最多1000个。趋势最多展示最近200批，返回真实total和truncated；无整库rawReport加载。输入或来源事实来自既有功能服务，Dashboard仅计算展示读模型，无新增迁移、后台任务或持久current副本。

共享DTO `packages/contracts/dashboard.ts`，DashboardModule.register(共享assessments引用,共享history引用) 导出DashboardService，必须复用同一个动态模块引用，避免重复worker。read model在 `dashboard.module.ts`，统计函数在 `metrics.ts`，页面独立功能注册。人工报告文字和Pi输出不作为统计输入。
