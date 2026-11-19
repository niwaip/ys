# 容器镜像 SBOM 与评估

客户 → 容器镜像对象 → 不可变资料快照 → 组件与镜像评估。镜像对象独立于软件应用与主机；没有运行实例关联字段，镜像内发现不自动成为任何主机/实例的发现。本片只接收已生成SBOM，不连接仓库、Docker daemon或集群。

## 支持输入与身份

复用CycloneDX JSON1.4–1.6组件清单适配器及500000 UTF-8字节/1000组件/30层限制；容器必须有metadata.component.type=container。软件入口拒绝容器根类型，避免把镜像资料归为软件应用。

镜像对象必填name、source（例如release-pipeline），同名对象不隐式合并。repository/digest/tag/architecture在每份输入快照保存；标签不是不可变全局身份。快照UUID始终是系统输入身份，version仅保存digest或null，declaredVersion保留metadata.component.version原义，不强制把任意声明版本解释为标签。

支持从根OCI PURL获取仓库、digest、tag与arch；遵循[OCI Package URL定义](https://github.com/package-url/purl-spec/blob/main/docs/types/definitions/oci-definition.md)的version及qualifiers含义。首片仅支持完整小写sha256:<64位hex>摘要；不把组件hash、镜像配置ImageID或任意属性名猜成manifest digest。非OCI根PURL、坏编码、重复限定符或不支持digest拒绝。

上传可显式提供repository/digest/tag/architecture。缺失保持null；显式声明与已取得的SBOM身份矛盾则400，不静默覆盖。basis区分sbom-oci-purl/operator/unknown，原始SBOM与原始声明分别可查。所有镜像身份都是上传资料声明，未联网核实；digest未知明确显示可变标签不足、架构/来源未知各有提示。多架构image index/manifest范围不做未经来源支持的推断。

保留所有原始JSON与扩展、SHA-256、采集/接入时间、OS组件/CPE、包PURL及发行版qualifier。操作系统信息只来自type=operating-system组件，不从包名猜发行版。

## 接口

均需Bearer；客户URL权限、对象和版本归属由后端同时校验。

| 请求 | 行为 |
|---|---|
| POST `/api/customers/:customerId/containers` | `{name,source}` 建立独立镜像对象 |
| GET `/api/customers/:customerId/containers` | 最近100镜像对象，`{items}` |
| GET `/api/customers/:customerId/containers/:containerId` | 镜像与输入版本历史 |
| POST `/api/customers/:customerId/containers/:containerId/sbom` | `{fileName,content,repository?,digest?,tag?,architecture?}` 原子保存快照 |
| GET `/api/customers/:customerId/containers/:containerId/versions/:versionId` | 组件、OS、镜像身份、缺口及来源编号 |
| GET `/api/customers/:customerId/imports/:importId` | 复用来源读取，format=container-cyclonedx-json，原文/哈希/声明/处理行 |
| POST `/api/customers/:customerId/assessments` | `{containerId,versionId,idempotencyKey}`，复用持久Trivy队列，202 |
| GET `/api/customers/:customerId/assessments?targetKind=container&targetId=:containerId&versionId=:versionId&limit=20&offset=0` | 同客户指定镜像/版本分页摘要，过滤为可选参数 |
| GET `/api/customers/:customerId/assessments/:id` | 原始执行/库/发现证据 |

每份资料按客户+格式+原文hash唯一。同对象、同内容、相同身份声明重复上传回读原importId/versionId，replayed=true；改文件名不新建。同内容重绑另一对象或更改身份声明409；不改写已保存身份。不同内容始终生成新输入版本，即使标签/digest相同。相同内容可独立存在于不同客户；同软件资料与容器资料用不同格式及对象路径区分。

无凭据401、未授权客户403、跨客户/跨对象/不存在版本404、坏结构/身份400、资料或幂等冲突409。原子事务防止只保存半份组件或虚假成功；资料和版本有同客户复合外键。

## 复用执行与读取接缝

容器与软件共用AssessmentService、TrivyExecutor和normalizeTrivy：工具不可用/失败/超时/中断、零发现、部分覆盖、过期库沿用[软件评估契约](software-assessments.md)。target.kind=container，target.containerId/versionId固定输入；input.version是digest|null，input.importId/hash保留原来源。不按镜像名/标签归并发现，不自动升级到最新上传。软件页面只列software任务，镜像页面只列当前镜像输入版本任务；切版本不带入其他版本的发现。

Trivy worker仅claim/recover software/container任务，Windows等后续worker使用自己的目标类型。所有消费者复用同一个AssessmentsModule注册实例。

`ContainersModule`导出`ContainerService.get(customerId,id)`与`getVersion(customerId,containerId,versionId)`；DTO位于packages/contracts/containers.ts。后续报告/统计须显式引用镜像版本及评估编号，不把tag当作版本身份，不将其自动纳入运行主机事实。任务列表targetKind/targetId/versionId均参数化筛选且不会取消客户范围。

## 本地验证

HTTP覆盖digest/同标签不同版本、OS/生态映射、原始资料、重启、重复/声明冲突、缺失身份、坏输入、跨客户/软件边界、任务结果及版本过滤。浏览器使用明确的假Trivy子进程/假离线库，展示库过期与工具发现；不执行真实扫描。

`PLAYWRIGHT_CHANNEL=chrome npm run test:browser -- --config playwright.containers.config.ts` 使用4286/3206及独立数据库；默认全套浏览器也可验收。本片未验证真实工具/镜像仓库兼容性，未部署或SSH。
