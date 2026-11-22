# Linux 系统包 CVE 扫描

本片将 Debian/Ubuntu 主机的不可变基础采集快照接入后台 Trivy 任务。入口：资产台账的“CVE评估”，或侧边栏“CVE评估 → Linux系统包扫描”。选择主机并配置关注等级后，单击“扫描”自动使用最新接入的采集版本；采集和扫描均不自动确认基线或写回 NetBox。

## 固定输入与覆盖

基础采集新增只读 `/var/lib/dpkg/status`、`/etc/lsb-release`、`/etc/debian_version`。目标无需安装 Trivy。原始包数据库保留 Source 包及版本语义；held包仍按已安装状态纳入，Trivy输出的epoch/版本/修订号会重建后与输入核对。扫描前核对 OS 及所有已安装包的名称、版本、架构与归一化清单一致。旧快照缺少原始数据库时提示重新采集，不合成无依据的 SBOM。

后台在独立临时目录仅重建发行版文件及 dpkg 数据库，执行 `trivy rootfs --pkg-types os --scanners vuln`，复用软件扫描的超时、进程隔离、离线数据库、空配置与退出状态处理。固定路径均由服务端生成，客户端不能提供扫描路径或命令。包括 SBOM 在内的扫描显式禁用遥测。Linux 报告默认上限100MB，其他扫描仍为5MB；配置中的 maxOutputBytes 可覆盖此限制。超限明确失败。

发行版识别必须与输入一致；无法识别、非零退出、无效 JSON 不生成有效结果。Ubuntu 需要 lsb-release，Debian 需要 debian_version。此片不支持 RPM、网络设备厂商规则、运行内核适用性判断、Docker 可写层、挂载卷或应用目录。应用和镜像组件继续走独立 SBOM 评估。

包出现在 Trivy Packages 中只说明被识别，不证明所有第三方包均有厂商漏洞匹配，因此 Linux 覆盖保守标记 partial，并展示匹配数量及缺口。发现为 tool_reported，不进行人工改判。数据库时间及执行前后元数据固定保存，过期或未知会披露。

参考：[官方 rootfs 范围](https://trivy.dev/docs/latest/guide/target/rootfs/)、[操作系统覆盖](https://trivy.dev/docs/latest/guide/coverage/os/)、[Ubuntu 分析器](https://github.com/aquasecurity/trivy/blob/v0.76.2/pkg/fanal/analyzer/os/ubuntu/ubuntu.go)。

## 接口与证据

- `GET /api/customers/:customerId/assessments/linux-inputs?assetId=UUID&offset=0`：每页20个采集快照，提供可扫描状态和阻断原因。
- `POST .../assessments`：`{assetId,snapshotId,idempotencyKey}`。同客户同输入同键回读原任务；网页仅保留“扫描”按钮，点击时读取最新接入版本再提交。若最新版本不支持则明确阻断，不自动回退旧版本；提交结果不明时重试保留同一输入与幂等键，成功后再次扫描创建独立请求。
- `GET .../assessments?targetKind=linux&targetId=UUID&limit=20&offset=0`：分页历史摘要。
- `GET .../assessments/:id?findingsOffset=0`：每页50条发现，返回 findingsPage 总量，不传原始整份报告。无此参数保留完整任务接口。
- `GET .../assessments/:id/report`：客户范围的原始报告下载，gzip压缩传输JSON封装 `{content,contentHash}`，网页保存原始报告内容。避免下载时重复传输所有归一化发现；原始内容哈希保持不变。

客户隔离和资产在管状态由服务端校验。删除后保留旧任务证据，但禁止提交新的资产扫描。共享持久队列在重启时恢复排队任务，将遗留运行任务标记 interrupted，禁止自动重扫。

每个任务保留原始采集快照哈希、重建输入哈希、工具版本/argv、DB 元数据、报告哈希和完整原始漏洞对象。Linux任务仅保留一份gzip压缩原始报告，各发现以报告哈希、Results序号和Vulnerabilities序号精确引用；读取和下载验证原始内容哈希。启动时将旧Linux任务转换为此存储格式，不改变任务身份、状态、发现判定或原文；已有备份可回退。Dashboard 将 Linux 作为 host 评估；报告冻结明确任务及来源快照，不随之后的采集或扫描变化。报告发布仍需内部复核。

## 验证

接口测试覆盖固定原生包资料、队列、幂等、分页、客户隔离、删除阻断、Dashboard 与报告冻结；进程测试验证受控 rootfs 构造。浏览器使用明确的假工具输出验证60条发现分页、原始报告下载及历史回读，不将替身冒充真实扫描。真实 YS 验证记录在部署验收文件中。

大报告以gzip压缩完整保存在任务数据库中，避免原文与每条漏洞描述重复存储导致内嵌数据库查询内存不足。解压和下载压缩仍在内存执行，当前单实例验证不表示已完成多客户并发容量测试。
