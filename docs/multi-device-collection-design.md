# 多类型设备资料采集：重新规划

2026-11-23。状态：用户已“按建议”确认工单拆分及范围，进入to-tickets发布；首期6项，SNMP v3为后续阶段。首期实现及本地验收已完成，现有生产部署不变。

## 用户要求

1. 采集入口应位于资产概览下，作为配置选项，而不是页面顶部的主机/Windows/CSV平行导航。
2. 重新解释并整合脚本结果与手动输入。
3. 支持网络设备、物理服务器等设备，明确其建档与资料录入入口，按NetBox模型规划。

## 规划时核对的现状（实施前）

- 生产NetBox为4.7.5。现有集成token查询设备角色、设备型号和平台目录均返回403；不能据此断言实例没有这些配置，本轮未扩大权限。
- NetBox Device是物理设备实例；物理服务器、交换机、路由器、防火墙、存储、PDU等可通过角色、型号和平台区分，并非各自独立顶层模型。Device Role为用户可配置的功能角色，Device Type对应厂家/型号。
- VirtualMachine是独立的虚拟计算对象；Module是设备内可替换组件。机柜、站点、接口、电源及IP等是其他管理/关联对象，不应一律套用Linux主机采集。
- 当前YS只同步device/virtual-machine，均写成host；本地hardwareType仅server/network/unknown。同步缓存保留platform、IP和序列号，但没有完整保留角色、设备型号/厂家等用于设备区分的资料。
- Windows入口接收windows-bat/1 JSON，保存Windows采集快照，并非在线Windows采集器。
- CSV入口主要导入资产清单；本地模式创建主机记录，NetBox模式沿用ADR002关联已同步原生身份。它不同于脚本生成的运行观测。
- 当前手动采集表单只有主机身份、OS等基础字段，缺少网络设备/服务器硬件/存储的专门资料模板。
- NetBox模式停用本地手工建档是既有权威来源规则。资产创建/维护仍可通过NetBox执行后同步，不能把手动观测直接变成另一份主数据。
- 现有在线/离线基础适配为Linux；Docker目录独立采集。支持在NetBox建档不等于已经具有该设备的自动采集能力。

事实代码：apps/api/src/netbox/netbox.module.ts、apps/web/src/features/windows/WindowsPage.tsx、apps/web/src/features/imports/ImportsPage.tsx、apps/web/src/features/collections/CollectionsPage.tsx；权威来源：docs/adr/002-netbox-asset-authority.md。

官方资料：
- https://netboxlabs.com/docs/netbox/models/dcim/device/
- https://netboxlabs.com/docs/netbox/models/dcim/devicerole/
- https://netboxlabs.com/docs/netbox/models/virtualization/virtualmachine/
- https://netboxlabs.com/docs/netbox/models/dcim/module/

## 设计树与第一轮已确认

A. 页面职责/位置：建议保留资产采集独立页面，概览下只有统一配置区，取消主机/Windows/CSV顶部导航。保留独立资产采集页面。
B. 接入方式：建议两类“自动/脚本采集”“手动输入”；前者收纳连接执行、下载脚本、上传结果，平台与格式由目标和文件决定。CSV资产清单归资产台账批量建档，不冒充采集结果。保留已有在线执行能力。
C. 首期对象范围：建议Device及VirtualMachine均可选择、建档关联和手动/受支持格式资料录入；组件附属于设备，机柜等关联展示。自动采集按已实现能力标记，不宣称全设备自动支持。

后续前沿（依赖A–C）：设备角色/平台映射及自定义分类；各类字段与采集内容；网络CLI/SNMP、服务器OS/管理口等协议的首期实现范围；主数据新增与观测补充的具体交互；结果预览/确认和历史；模板兼容及验收拆分。

## 已确认的设备规划（按工单范围收敛）

D. 分类：以NetBox原生身份为准，物理设备保留角色、厂家型号、平台；YS将角色映射为服务器、网络/安全、存储、电源/其他表单，允许配置映射，无法识别时用通用设备表单。虚拟机独立分类；OS不作为设备类别。
E. 内容：通用身份/型号/序列号/版本；服务器及VM增加OS、硬件与软件，网络/安全增加系统固件及模块，存储增加控制器/固件，电源/其他用通用版本及支持期限资料。Docker仅对适用宿主机开放，不作为与服务器并列的资产类型。首期不采集配置全文、口令或业务流量。
F. 自动化范围：保留Linux SSH/本机与Docker采集；Windows先统一脚本上传。网络/安全、存储、电源先支持手动及统一结果文件，后续阶段新增SNMP v3只读采集基础身份和固件；厂商CLI、Redfish/IPMI、Windows远程执行放入后续阶段。能力不支持时明确提示并提供脚本或手动路径。
G. 新增入口：目标选择旁提供新增资产；NetBox模式创建Device/VM并同步后继续采集；已有资产手动录入形成观测，不直接覆盖主数据。显示清晰的主数据来源及维护入口。

用户已确认据此拆分工单：设备分类及手动录入、统一配置、脚本导入、新增NetBox资产、结果确认与历史、CSV台账入口为首期；SNMP v3为后续阶段。具体字段、校验及错误处理通过各工单验收标准约束。

## 已确认页面骨架

资产概览 → 采集配置（目标资产/新增、资料接入、适用采集内容、执行或上传设置） → 结果预览与确认 → 采集历史。

“设备类别”“操作系统平台”“接入方式”“采集内容”属于不同维度；已将设备资料类型、角色及资料接入方式定义写入GLOSSARY。现阶段没有新增架构决定；若需改变NetBox权威来源或固定身份，将单独讨论ADR。

## 已发布工单

规格：https://github.com/niwaip/ys/issues/39

| 工单 | 内容 | 原生阻塞项 |
|---|---|---|
| #40 | 多设备分类与手动资料录入 | 无 |
| #41 | 统一采集配置工作台 | #40 |
| #42 | 统一脚本下载与结果导入 | #41 |
| #43 | 新增NetBox资产后继续采集 | #40 |
| #44 | 采集结果确认与历史追溯 | #41、#42 |
| #45 | CSV清单回归资产台账 | #41 |
| #46 | 后续阶段SNMP v3 | #40、#44 |

7项均已关联规格父工单，设置ready-for-agent并核验原生阻塞关系。首期不依赖#46；未修改或关闭既有工单。

## 首期实现契约

- 概览下统一配置，自动/脚本入口收纳Linux SSH、本机、离线、Windows离线及结果上传；手动输入根据设备资料类型展示字段。未知角色用通用设备表单，角色映射按客户保存。VM原生身份不可被改作物理设备资料。
- NetBox缓存新增保留role及deviceType（含厂家），不改变原生身份或Tenant。`GET /netbox/catalog?objectType=device|virtual-machine`按对象读取适用目录，逐页完整校验；403明确显示权限缺口，不静默回退本地主数据。新增资产用原有持久幂等操作，成功后选择返回的资产；失败不自动重复创建。
- `GET/POST /collections/role-templates`读取/保存客户角色ID到表单类型映射。设备资料使用兼容的ys-host/1，在`sections.device`中保存category及适用字段：manufacturer、model、firmware、modules、controller、cpu、memory、disks、software、supportUntil。日期须合法；不适用的非空字段拒绝，未知项留空，不假造软件包或固件CVE支持。
- Windows windows-bat/1经统一上传规范化为不可变观测，原文及所有解析字段保留；历史列表仅返回小型摘要，软件/KB使用Windows资料端点按50项分页预览，避免列表携带整份原文。目标需登记与资料一致的序列号，或使用从当前资产下载的脚本所声明的TargetAssetId（适用于无原生序列号的VM）；已有序列号仍须一致。缺失稳定关联或声明冲突返回409，不按名称自动关联、不创建本地副本。只在完整采纳OS区块后，事务发布绑定同资产的Windows评估资料。旧版Windows接口和历史证据保持兼容；旧同名待关联资料在明确采纳后可复用原导入编号绑定目标。
- 所有范围的任务结果直接在当前页预览，可查看差异、原文和历史。新工作台确认传`writeMasterData:false`，只更新YS基线；既有主数据显式维护/旧版基线协议保留兼容行为。`POST /assets/:assetId/baseline/reject`接受snapshotId及reason，拒绝决定保存操作者和时间，不更新基线。已采纳/处理中资料不能被拒绝，已拒绝资料不能再采纳；修正后另存观测。
- 迁移31将旧快照标为无需新确认，新写入观测标记review_required。新Linux扫描需同一快照的完整OS及系统包确认；只确认身份或排除OS字段不能解锁扫描，旧评估及迁移前快照保持兼容。部分采纳后可补充采纳其他区块。
- CSV清单入口移至资产台账，旧CSV地址引导到台账，预览、整批事务及身份规则保持原义；脚本上传不经过CSV清单适配。
- NetBox Device/VM建档与采集观测分开。支持终止日期为带来源的设备观测资料，不自动覆盖NetBox生命周期主数据。SNMP v3、厂商CLI、Redfish/IPMI及Windows远程执行均不在首期范围。

## 验收与运行限制

测试边界沿用已确认的客户HTTP API与浏览器端对端，不测试私有方法。外部NetBox、SSH和Trivy使用隔离替身；页面与YS API、持久化运行真实代码。Windows脚本在本机提供下载和结果适配验证，当前macOS环境未实际执行Windows命令；生产NetBox目录权限问题仍需运维授予对应读取权限。此实现未修改生产令牌权限。

专项命令：`PLAYWRIGHT_CHANNEL=chrome npx playwright test --config playwright.multi-device.config.ts`，验证NetBox分类、角色映射、新增Device/VM、403、失败幂等及采纳不写回主数据。Docker专项沿用`playwright.container-runtime.config.ts`。常规命令为`npm test`、`npm run build`和`PLAYWRIGHT_CHANNEL=chrome npx playwright test`。

## 本地验收结果（2026-11-23）

- API：31个测试文件、109项通过。
- 常规浏览器端对端：34项通过，1项Pi环境专用测试跳过。
- NetBox专项：3项通过，包括超过100项资产翻页时保留所选VM身份及类型锁定。
- Docker专项：4项通过；类型检查、生产构建和差异空白检查通过。
- Standards复审：已将资产分类推断移回前端功能模块，字段校验与表单共用适用性规则；无剩余具体问题。
- Spec复审：已修复不适用设备重新进入连接采集、翻页丢失目标身份，并补充已有序列号不可通过缺失值绕过的回归；无剩余具体问题。
- 审查固定基点为`65cbaa9c47b5fd40cc112c0604bba5429b97f6e4`，首期实现提交为`7a592f6`。本轮为本地实现，未部署生产；SNMP及实际Windows脚本执行仍遵循前述范围与环境限制。
