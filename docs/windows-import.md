# Windows BAT JSON 输入与快照契约

首个适配器 `windows-bat/1` 接收已经采集的 Windows BAT JSON 对象，字段来自已讨论的旧 Windows 上传资料结构。它不运行采集器、不执行评估。当前支持 `CollectorVersion` 缺失（legacy 未声明结构）或字符串 `1`；其他版本保留原文与归一化预览，状态 `unsupported_version`，不生成可评估快照。`1` 是当前明确支持的输入契约版本，不声称验证了外部采集器发行版。

```json
{"Hostname":"WIN-01","SerialNumber":"serial-001","CollectorVersion":"1","CollectedAt":"2026-11-01T10:00:00+08:00","OS":"Windows Server 2022","OSVersion":"10.0","OSBuild":"20348","UBR":2402,"Architecture":"x64","InstalledSoftware":[{"Name":"Example","Version":"1.2","Publisher":"Example vendor"}],"InstalledKBs":["KB5030216"],"CollectionStatus":{"Overall":"PARTIAL"},"KBInventoryComplete":false,"SoftwareInventoryComplete":true,"RebootPending":false}
```

UTF-8 JSON，可含 BOM；最多 500000 字节，不含 NUL；上传 JSON body 沿用 1 MiB 总限制。唯一必填字段 `Hostname`（去空白后 1–200 字符）。可选字符串字段最多 500 字符；不猜字段别名。`UBR` 为非负整数或 null，0 是有效值。`OSBuild` 与 `FullBuild` 保留来源字符串，不按浮点数解释。采集时间为带时区 ISO 时间，缺失为 null，不以导入时间补齐。

`InstalledSoftware` 是对象数组，读取 `Name`/`Version`/`Publisher`，空字符串为未知 null；每行原始扩展保留。`InstalledKBs` 是 KB 编号数组，`KBDetails` 是含 `KB` 字段的对象数组，合并编号为去重的大写列表，不推断替代关系。缺失数组为 null，明确空数组为 []。两种数组最多各 10000 项。`CollectionStatus` 原样保留来源状态；`KBInventoryComplete`、`SoftwareInventoryComplete`、`RebootPending` 只接受 boolean/null，缺失保持 null；失败或部分采集不改成零发现。其他字段及软件错误、KBDetails、厂商扩展均可从 `snapshot.extensions` 和精确原文追溯。

## HTTP 接口与归属

所有请求使用 Bearer 操作员凭据，后端校验 URL 客户权限和 SQL 客户范围。

| 请求 | 返回 |
| --- | --- |
| POST `/api/customers/:customerId/windows/imports` | `{fileName,content}` → 201 资料、原文、SHA-256、处理状态、资产/快照编号、归一化 snapshot |
| GET `/api/customers/:customerId/windows/imports` | 最近 100 份资料 `{items}`，不包含 content |
| GET `/api/customers/:customerId/windows/imports/:importId` | 原始资料和固定处理结果 |
| GET `/api/customers/:customerId/windows/snapshots/:snapshotId` | `{id,customerId,assetId,importId,snapshot}` 固定评估输入 |

401 无凭据、403 未授权客户、404 其他客户或不存在对象、400 字段/JSON/编号无效。body 不接受 customerId。无效格式不会落库。成功解析的未知版本及身份问题保留资料；不是成功创建资产。

客户 + `windows-bat` 来源 + 有效 `SerialNumber` 是此适配器稳定身份，复用同一客户该序列号的资产，新内容创建新的快照。缺少序列号、常见占位序列号或没有稳定匹配且已有同名资产时为 `pending_confirmation`，不按主机名/IP 合并，不自动创建资产。人工/CSV 身份不自动转换为 Windows 身份。待确认资料当前只读，需补充或修正来源后重新上传；本片不提供人工强制关联。

相同客户+格式+精确原文 SHA-256 返回同一资料、同一快照，`replayed=true`；改文件名不影响身份。不同客户完全独立。不同内容保存独立资料及快照；不会修改旧资产主数据、旧快照或评估依据。所有资料、身份和快照创建在 `Database.transaction` 内原子提交。复用 `import_materials` 保存来源和处理结果，资产继续复用既有台账；独立 `windows_identities` 和 `windows_snapshots` 保存适配器身份与固定证据，迁移号 3。

## T07 接入边界

后续 Windows 评估用 `WindowsService.getSnapshot(已验证customerId,snapshotId)` 或同义 HTTP 接口取固定快照，不按资产最新上传资料替换历史输入。同时保存 importId、snapshotId、内容哈希、adapterVersion 与规则版本；原文由客户范围资料接口回读。`packages/contracts/windows.ts` 提供页面契约。

OS/OSVersion/OSBuild/UBR/Architecture、KB 列表、完整性和重启状态是后续 OS 证据；软件名称/版本/厂商是软件候选识别依据。当前 assessmentSupport.state 为 `not_assessed`。没有 CPE/产品分支或来源证据时不能证明适用性，缺少完整性时不能证明已修复。数字较大的 KB 不自动覆盖其他 KB，采集成功和空清单不表示安全。
