# 主机 Docker 镜像生成与扫描

2026-11-23，用户调用 implement 并要求端到端验证，按会话六项拆分实施。范围为 Docker，不含 Kubernetes、containerd 或仓库直接拉取。

## 用户流程

- 选择主机生成：选择在管主机及已授权 Docker 的连接，发起目录发现；默认展示运行容器所用镜像，可查看全部本地镜像。按完整 Docker ImageID 合并多标签目录，保留容器名称、状态及完整编号。
- 选择1–100个目录中的镜像，后台分别生成不可变 SBOM 并进行漏洞评估。一次批量中重复 ImageID 合并；同一请求编号重试回读任务，部分失败不抹去成功项。
- 手动镜像资料：上传已有 CycloneDX 或 ys-image/1 生成包，可选择主机，也可保存独立镜像资料。保留原镜像对象及版本管理入口。
- 离线脚本：下载独立 Node.js 包装脚本，在已安装 Docker、Trivy、Node.js 的目标主机运行，生成 JSON 后上传。不会自动安装、sudo、拉取仓库镜像或改变运行容器。
- 主机详情及 Dashboard 展示观测、资料版本及任务概要，可进入镜像页面查看固定来源及评估结果。镜像发现不自动等同主机/实例已确认受影响。

## 日期、身份与证据

主机目录快照、生成 SBOM、漏洞评估分开保存。完整 Docker ImageID 用于选定本地镜像，不冒充 manifest 或 image index digest；标签不是固定身份。生成前后核对 ImageID，主机 machineId 已知时核对生成资料与目录来源。人工上传始终标为操作员声明，即使附带主机信息也不升级为自动验证。

自动来源保存目录快照编号及 hash、镜像 ImageID、架构、关联容器、生成工具/时间、SBOM hash、原始产物 hash。评估输入冻结该来源；新目录、新上传、新评估不改写旧证据。原始生成包与原始 SBOM 可分别回读。镜像对象、输入版本、来源与原始产物原子接入。

不隐式按标签跨主机合并。相同客户且精确原文相同的 SBOM 复用已有镜像输入，来源单独保存；生成时间等导致原文不同则保存新版本。历史任务数与镜像版本/观测数分别展示。

## 执行边界

沿用客户/资产绑定的连接、严格 SSH 公钥校验、加密凭证、临时文件清理及 NetBox 归属核验。只允许已在目录中出现的完整 ImageID，不接受网页自由命令或 Docker 地址。执行前重新核验资产与连接授权。

目标端使用固定本地 Docker socket 和 Trivy image 的 Docker-only 来源；生成 CycloneDX 默认不做漏洞扫描，随后 YS 服务端用已配置的离线漏洞库评估保存的 SBOM。缺少目标 Trivy/Docker、镜像被删除、超时或权限不足明确失败，不当作零风险。不读取容器完整环境变量，不扫描可写层或挂载卷。

生成与评估各自记录状态；后端重启将执行中的生成任务标为中断，待执行任务恢复。显式重试产生新任务，已有 SBOM 时复用保存版本重做评估，保留旧失败记录。

## 容量

容器入口支持 CycloneDX JSON 1.4–1.7（Trivy 0.76.2 实际默认输出1.7）；软件入口支持范围保持1.4–1.6。容器 SBOM/生成包上限20000000 UTF-8字节，50000组件，嵌套30层；请求体32MiB。超过任一边界明确拒绝，不截断。软件 SBOM 仍使用既有500000字节/1000组件默认限制。

目录读取与输入解析均设置上限。镜像/来源/任务页面列最近100项并明确标注，主机选择支持分页。概要按资料和最近镜像观测统计，不宣称实时运行状态。

## 接口

客户前缀 `/api/customers/:customerId/container-runtime`，沿用 Bearer 和客户隔离。

| 请求                         | 行为                                                                      |
| ---------------------------- | ------------------------------------------------------------------------- |
| POST `/discover`             | assetId、profileId、idempotencyKey，复用目录采集任务                      |
| GET `/inventory/:snapshotId` | 固定目录、镜像分组、容器关系及未知状态                                    |
| POST `/jobs`                 | assetId、profileId、snapshotId、imageIds、idempotencyKey，202生成批量任务 |
| GET `/jobs`                  | 最近任务，可选assetId                                                     |
| GET `/jobs/:id`              | 固定任务及评估进度                                                        |
| POST `/jobs/:id/retry`       | 新idempotencyKey，显式重试未成功终态                                      |
| POST `/imports`              | name、fileName、content，可选assetId/snapshotId，原子接入资料及来源       |
| GET `/sources`               | 固定来源，可选assetId                                                     |
| GET `/sources/:id/artifact`  | 原始上传/生成产物与hash                                                   |
| GET `/script`                | 离线生成脚本                                                              |
| GET `/summary`               | 资料/观测及任务状态概要，可选assetId                                      |

评估接口增加可选 containerSourceId，仅允许与同客户、镜像及输入版本一致的来源，冻结到本次输入。

生成参数依据：[Trivy SBOM](https://trivy.dev/docs/latest/supply-chain/sbom/)、[Trivy image CLI](https://trivy.dev/docs/latest/references/configuration/cli/trivy_image/)。实际工具兼容性需要与固定夹具验证分别记录。
