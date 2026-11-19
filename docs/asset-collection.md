# NetBox资产与网页分层采集

本地实现，2026-11-19。来源：[规格#18](https://github.com/niwaip/ys/issues/18)及后续NetBox方向澄清。没有连接或修改远端NetBox/YS，没有真实SSH、Pi提供商或Trivy扫描验收。本次实现直接提交当前ys/integration分支，按功能组织；测试边界沿用业务HTTP、关键浏览器流程和固定外部进程替身。

## 主数据及迁移

配置见`.env.example`：`YS_NETBOX_URL`必须指向`/api/`，私有`YS_NETBOX_TOKEN`及`YS_NETBOX_TENANTS`只由服务器读取。Tenant必须唯一对应已登记客户。配置后客户资产页提供同步、新增Device/VM、修改名称/序列号、历史ID映射；Device要求设备类型/角色/站点原生ID，VM要求站点或集群。没有重建NetBox的站点/IPAM编辑器；其他配置可继续在NetBox维护。

先对需要保留的历史YS编号建立映射，再同步。若已经同步成另一个YS编号，会明确冲突，不自动合并历史。接口`GET /netbox/mappings`最多列100项，可直接填写完整历史资产UUID映射。同步按完整分页读取Device及VM后在事务中更新缓存；不匹配Tenant、重复/不完整分页、远端失败不会留下半批结果。删除/移出客户的对象保留非活动映射；提交快照及Pi执行前会重新读取原生详情校验Tenant，缓存尚未刷新也不能绕过。台账为缓存，来源详情中有同步时间，映射面板显示活动状态。

NetBox模式下：

- `POST /assets`关闭本地主数据建档，使用`POST /netbox/assets`；`PATCH /netbox/assets/:assetId`仅修改名称及可选序列号，不改变资产类型/Tenant/运行状态。
- CSV预览保持原有行为；提交时`sourceRef`必须为`device:42`或`virtual-machine:42`并已同步/映射。CSV的原文及行内观测作为导入资料保留，不覆盖主数据。不会从任意CSV行猜测设备类型、站点或自动创建NetBox对象。
- Windows上传按同客户、同实例的活动资产唯一序列号关联，并向NetBox重新核验。没有唯一关联时保存`pending_confirmation`，不新建本地主机。旧的待确认资料目前没有网页重新关联流程；需补齐该操作后才可完成其快照归档。
- 未配置NetBox时仍是显式本地模式；不存在配置后失败转回本地建档的兜底。

原生写入需`idempotencyKey`。持久操作在`GET /netbox/operations`读取；失败或响应丢失按unknown处理，远端可能已写入，核对后同步或显式映射，不能自动重试创建。本地缓存成功不代表完成真实版本兼容验收。

所有下列路径均为`/api/customers/:customerId`前缀，需现有操作员授权。

## 网页三入口

“资产采集”选择明确YS资产UUID：手动输入、上传ys-host/1脚本JSON、或调用Pi。快照保留接入时间、可空的来源时间、入口、目标资料、原文、SHA256、扩展和分项状态。未知时间不会被接入时间代替。序列号或历史machineId冲突返回409；同内容重复提交同入口/同目标回读原快照，跨目标或来源声明冲突拒绝。

`POST /collections/manual`：`{assetId,note,data}`。`POST /collections/upload`：`{assetId,fileName,content}`。上传最多5000000 UTF-8字节、50000条包记录，以先达到的边界为准；超限明确拒绝，不截断。JSON请求上限8MiB，原文JSON转义后也受该边界限制。现有软件/镜像SBOM仍保持独立的500000字节/1000组件上限，尚未提升。

```json
{"schemaVersion":"ys-host/1","identity":{"hostname":"ys","serial":null,"machineId":null},"collectedAt":null,"sections":{"os":{"status":"acquired","data":{"id":"debian","version":"12","kernel":"6.1","architecture":"x86_64"}},"packages":{"status":"acquired","data":[{"name":"openssl","version":"1:3.0.11-1~deb12u2","architecture":"amd64","state":"installed","manager":"dpkg"}]}},"extensions":{"source":"客户脚本"}}
```

分项包含os、packages、hardware、network、dockerClient、dockerDaemon、containers、images。状态为acquired/partial/not_collected/unsupported/permission_denied/failed；缺失分项为not_collected，明确空清单用`[]`，未知用`null`。系统包保留完整版本、架构、dpkg/rpm及installed/config-files/unpacked/other/unknown安装状态。扩展资料放extensions，未知schemaVersion明确拒绝。

`GET /collections/snapshots?limit=20&offset=0&assetId=UUID`；`GET /collections/snapshots/:id`读取概要；`.../:id/raw`读取原文；`.../:id/sections/packages?limit=50&offset=0`等读取分项，数组明细分页。概要不携带包数组或采集器rawSections；原文仍完整保留。历史版本不会被新内容改写。

## Pi与固定SSH能力

配置`YS_PI_EXECUTABLE`及`YS_COLLECTION_PROFILES`后，网页选择受控连接，`POST /collections/jobs`提交`{assetId,profileId,scope,message,idempotencyKey}`。连接绑定客户和YS资产UUID，服务器配置地址/账号/密钥文件/可信主机文件；不会从需求文本提取命令或目标。私钥需仅属主可读的普通文件。工具响应/任务不返回这些配置或私钥。

Pi使用独立RPC会话，仅开放`ys_host_collect`，工具参数为空。固定工具通过版本化脚本获取资料，后台检查工具完成事件及产物中的任务/客户/目标/连接/范围。未执行工具、产物不匹配、输出超限和超时均不会建立成功快照。SSH主机身份、登录、连接、超时、输出超限和协议失败通过绑定任务的固定错误代码返回，原始SSH错误文本不进入模型或任务。单后端worker持久保存queued/running/succeeded/partial/failed/unavailable/timed_out/interrupted，刷新可回读；运行任务重启标记中断，不自动重连。`GET /collections/jobs`最多100项；`.../jobs/:id`读取任务。未配置Pi时API保存unavailable任务；页面没有连接时明确要求管理员配置或改用离线入口。

SSH强制BatchMode、StrictHostKeyChecking、专用known_hosts、指定身份文件、禁用agent及用户SSH配置，设置连接/执行期限与8MB输出上限。固定POSIX shell使用现有`uname`、`cat`、`dpkg-query`或`rpm`、`df`、`ip`等读取；目标不需要Trivy/Python/Node。Linux包数据库直接支持Debian/Ubuntu及RPM系；其他平台/缺命令保留不支持或失败，真实发行版兼容尚未验证。

基础scope=`basic`读取OS、运行内核、架构、可见硬件/网络、系统包和Docker CLI版本；`allowDocker:true`时才查询本机daemon实际版本。不能用CLI版本替代daemon版本。scope=`container-inventory`独立读取容器ID→ImageID及镜像ID/标签/digest目录，要求allowDocker；digest类型未知时保留unspecified，不混同ImageID或manifest/index。仅固定必要字段，不读完整inspect环境变量。两种scope都不执行Trivy、安装、sudo或权限修改；容器目录不等于内部组件扫描。

## 软件、镜像及独立评估

软件/镜像内部组件继续使用已有SBOM上传。`POST /collections/links`需明确`assetId,snapshotId,kind,objectId,versionId,basis`，镜像可另提供完整imageId（或SBOM已有digest）；`GET /collections/links`最多100项。关联固定SBOM输入hash和主机快照hash，依据始终为操作员声明，记录声明者，不凭同名或标签自动证明部署关系。镜像SBOM不覆盖实例可写层、挂载卷或运行暴露。

在快照详情保存关联后，可显式发起该SBOM版本评估；现有`POST /assessments`额外接受`linkId`，服务端核对同客户和同对象版本，将关联冻结进input.provenance。报告固定事实、HTML预览与后续复核保留此来源链；不会因为之后更换关联或重新采集而改变旧评估。未传linkId的旧软件/镜像流程保持原义。

`GET /collections/snapshots/:id/assessment-input`明确返回unsupported：主机基础数据/原始Linux包清单尚无通用评估适配器。不会自动选择最新资料，不会把未评估或失败变成零发现。镜像内容目前采用上传SBOM路径，未新增远端Trivy image生成能力。

## 未完成的扩展与真实验收

完整N01–N13不能标记全部结束：CSV自动创建原生对象、Windows待确认资料的网页重新关联、NetBox更多原生字段编辑/选项检索、大SBOM扩容、远端Trivy image产物生成，以及真实NetBox/Pi/只读SSH环境兼容验收仍待后续完成。现有代码和菜单可用不代表这些能力已经上线；本轮未部署8001服务。

官方模型依据：[NetBox Device](https://netboxlabs.com/docs/netbox/models/dcim/device/)、[VirtualMachine](https://netboxlabs.com/docs/netbox/models/virtualization/virtualmachine/)、[REST API](https://netboxlabs.com/docs/netbox/integrations/rest-api/)。这些文档描述原生模型，不替代对YS现有NetBox版本的兼容验收。
