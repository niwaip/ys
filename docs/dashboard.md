# 客户风险概览与风险结果

T12 是客户范围只读聚合，不创建扫描、评估或风险分数。按组合→对象→固定输入版本/快照→评估→证据逐层查看。没有跨客户合并视图；报告复核、文字编辑和导出不参与计算。

## 当前与选择规则

- 软件默认复用 T11 `SoftwareHistoryService.current(customerId,softwareId)` 的显式指针。current=null，或指针只有 versionId 而 assessmentId=null 时，评估保持未选择；组件数可由已选 SBOM 输入取得，但不会从最近成功任务补齐风险。上传或重扫不改变指针。
- 首页固定采用 `selectionMode=current`：软件遵守显式 current 指针；主机及容器采用最近一次评估尝试，失败不回退成功结果。不累计历史。风险结果页保留显式选择批次和历史趋势。
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

概览最多1000个对象；超限明确400，要求通过分页目录缩小到单对象，不截断后返回假总计。assessmentRefs最多1000个。趋势最多展示最近200批，返回真实total和truncated；无整库rawReport加载。输入或来源事实来自既有功能服务，Dashboard仅计算展示读模型，无新增扫描或后台任务。迁移28新增压缩固定概览读模型，不复制 current 指针。

共享DTO `packages/contracts/dashboard.ts`，DashboardModule.register(共享assessments引用,共享history引用) 导出DashboardService，必须复用同一个动态模块引用，避免重复worker。read model在 `dashboard.module.ts`，统计函数在 `metrics.ts`，页面独立功能注册。人工报告文字和Pi输出不作为统计输入。

明细 findings 复用 view 的同一范围解析：对象归属、评估引用匹配/去重、软件当前评估及时间筛选保持一致。只传 object 时使用相同当前指针，不回退历史；object 与 assessmentRefs 不匹配时两个接口均拒绝。

## 单页首页与固定链接（#34–#38）

`#dashboard` 在1440×900桌面以四组数字卡片显示资产、CVE、生命周期风险和评估覆盖，不显示表格、日志或批次配置；390宽手机纵向排列。`#risk` 为独立完整风险结果页，保留对象、观测、趋势及固定证据。

- POST `/dashboard/overview` 接受空对象，返回 `{id,generatedAt,metrics}`。内部按 current 解析后将完整展示读模型 gzip/base64 保存到 `dashboard_scopes`，带 SHA256 校验及客户归属。
- GET `/dashboard/scopes/:id` 回读固定概览。刷新、新增对象及 current 改变不影响该链接；跨客户返回404。固定概览保存名称、归一化观测与趋势，不包含 rawReport。当前不自动清理，避免已发出的链接失效；需监控读模型存储增长，后续单独设计保留策略。
- POST `/dashboard/findings` 新增 `scopeId`、`severity`（小写五级）及 `state`（unselected/succeeded/failed/stale/coverage_unknown/freshness_unknown）筛选；可进一步按 hardwareType 限定。scopeId 与重新解析范围的参数混用返回400。分页统计及对象表共用筛选规则。
- 首页致命/高危数为匹配记录条数，不是确认影响资产；唯一CVE为去重标识数。点击后进入 `#risk?scope=…&severity=high` 等固定范围。资产入口进入对应台账，网络卡片进入同范围网络对象。
- GET `/lifecycle-risk/summary` 仅返回固定视图ID、时间、summary及 active风险中处理状态pending的项数。生命周期等级卡单位为资产，按资产最高等级归类；待处理卡单位为风险项。点击进入固定 `view`、`level`、`assetLevel`（最高资产风险等级）和 `handling` 筛选，接受风险不会消除等级。

两类摘要独立读取，分别携带自己的固定ID与生成时间。网络或计算失败显示错误/未知，不将不可用数据转换为0。风险结果页 current 默认与旧文档中显式选择的说明不同：高级配置仍可改为显式批次模式。
