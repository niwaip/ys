# 软件 SBOM 接入

软件对象独立于主机资产：客户 → 软件对象 → 不可变输入版本 → 组件。人工建立的软件对象同名不合并，每个输入版本有独立 UUID；缺失发布版本为 null，UUID 不冒充发布版本。当前仅软件，不将容器根对象冒充软件部署或运行实例。

支持 UTF-8 CycloneDX JSON 1.4、1.5、1.6 的组件清单子集：必填 bomFormat、specVersion、components 数组；组件必填 name/type，可选 version、PURL、CPE、bom-ref，支持嵌套 components。允许空组件清单，明确显示 0 个组件、未扫描。没有执行漏洞评估，也不宣称全量 CycloneDX schema 校验；未知扩展及 dependencies 等来源信息保留在原始 JSON，当前关系视图只展示嵌套组件父子关系。拒绝重复组件 bom-ref、坏 JSON、不支持版本、无效组件结构或 PURL。metadata.timestamp 非空必须为含时区的 ISO 时间。最多 500000 UTF-8 字节、1000 个组件、30 层嵌套；API 总体请求上限 1 MiB。

缺失组件版本或 PURL 不补造；组件 issues 提示漏洞匹配可能不完整或包生态未知。包生态仅取 PURL type，无 PURL 不根据名称猜测。软件发布版本来自 metadata.component.version，采集时间来自 metadata.timestamp，缺失保留 null；元数据根与所有扩展均在原始资料保存。

所有请求带 Bearer 凭据，服务端对 URL 客户授权，查询同时限制客户与软件/输入编号。

| 请求 | 行为 |
|---|---|
| POST `/api/customers/:customerId/software` | `{name}` 创建独立软件对象，201 |
| GET `/api/customers/:customerId/software` | `{items}` 最近100对象 |
| GET `/api/customers/:customerId/software/:softwareId` | 对象及全部输入版本历史 |
| POST `/api/customers/:customerId/software/:softwareId/sbom` | `{fileName,content}` 原子接入并返回输入快照，201 |
| GET `/api/customers/:customerId/software/:softwareId/versions/:versionId` | 指定输入快照及组件、未知说明 |
| GET `/api/customers/:customerId/imports/:importId` | 复用既有客户资料来源接口，含精确原始文本、SHA-256、导入时间、处理结果 |

import_materials 复用客户/格式/哈希身份、原始文本、文件名、接入时间与原子处理状态；format 为 cyclonedx-json。result 保存 softwareId、versionId、行→componentId 及 issues。SBOM 上传即原子提交，无 CSV 预览阶段。相同客户/内容返回原 importId/versionId 并 replayed=true（改名不改变身份）；若同一内容已关联另一软件对象则409，防止资料身份含糊。内容变化生成新输入快照，同发布版本亦保留历史。不同客户的相同内容建立独立资料、对象与组件编号。提交失败整笔回滚，不建立部分组件或虚假成功资料。

无凭据401、未授权/未知客户403、跨客户/不存在对象与版本404、非法编号/坏文件400；并发内容身份冲突409可重试读取已保存版本。

## 扩展接缝

`SoftwareModule` 导出 `SoftwareService`，`getVersion(customerId,softwareId,versionId)` 返回 `SoftwareVersion`（packages/contracts/software.ts）。T05 评估必须绑定 versionId、importId，按客户取得原始资料，不按名称串联；可以复用 ImportsService.get 取原始文本/哈希。T06 容器应独立定义对象语义，可复用 import_materials 和 Database.transaction，不将镜像内组件自动关联到软件或运行主机。组件 ID 仅在该输入版本内有意义。
