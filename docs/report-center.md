# 扫描报告中心运行与接口

报告中心沿用 `#reports`；旧评估引用入口收在兼容区，历史报告及正式 HTML 保持原身份。新流程依次选择范围、结果来源、检查覆盖、配置章节/附件、创建任务。范围支持当前客户在管物理服务器及 VM，明确关联的软件及镜像合并为共享对象；未关联资料不自动归入主机。

## 固定输入及任务

所有业务 API 使用现有 Bearer 操作员与 URL 客户范围。报告不接受客户端事实。

前缀 `/api/customers/:customerId/report-center`：

| 接口                              | 行为                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| POST `/preflight`                 | 使用任务配置预检当前范围、资料、可用结果与时效，不提交外部操作；最终名单在创建任务时固定 |
| POST `/tasks`                     | 202，持久任务；`name`、`scope`、`mode`、`idempotencyKey` 必填                            |
| GET `/tasks`                      | 最近 100 项摘要，不传重复事实或比较基准正文                                              |
| GET `/tasks/:taskId`              | 固定范围、分项输入/评估/采集批次、等待与错误；完成后含 `reportId`                        |
| POST `/tasks/:taskId/retry`       | `{itemIds}`，只重试失败/中断项，记录此前评估引用及尝试号                                 |
| POST `/tasks/:taskId/resume`      | `{}`，上传/确认后继续等待任务，复用同一采集批次                                          |
| POST `/tasks/:taskId/cancel`      | `{}`，停止后续派发，保留已派发评估及资料                                                 |
| POST `/tasks/:taskId/finish`      | `{}`，执行结束或等待时保留缺口生成报告，不纳入未终态评估                                 |
| GET `/hosts/:assetId/assessments` | 该客户主机完整历史候选，用户可明确选旧批次                                               |

`scope` 为 `{kind:"selected",assetIds:[uuid]}` 或 `{kind:"tenant"}`。`mode` 为 `existing`、`assess`、`collect`、`incremental`；增量任务分别检查采集及评估：采集缺失、陈旧或日期未知时进入采集/确认等待，可显式设置 `allowExistingCollection:true` 采用现有采集资料并仅补评估；关联 SBOM 需更新并明确关联新版本，或明确采用既有资料，不以评估时间刷新。`collect` 复用资产已保存配置及实际能力，经原有上传/基线确认边界后执行；不支持或未配置项保留缺口。Linux 输入仍限已接入的 dpkg 范围；Windows 必须明确提供 `windowsRuleImportId`，不声明完整厂商补丁覆盖。

`freshnessDays` 默认 7，单独检查采集和评估。`overrides` 显式历史选择必须属于当前范围及客户。`sourceReportId` 记录采用新结果时的来源报告，`comparisonReportId` 固定基准修订；只在同对象、输入版本、解析/规则能力及覆盖可比时比较发现，移出主机不算问题消失，“未再观察到”不等于修复。

`presentation` 配置 `topic`（combined/vulnerability/lifecycle）及 `optionalChapters`（summary/overview/recommendations）。范围、覆盖、未知及来源不能关闭。呈现变化经既有 `POST reports/:reportId/revisions` 产生同事实新草稿并重新复核。

可选 `output:{pdfMode:"summary"|"full",perHost:boolean,evidence:boolean}` 在报告完成后自动创建草稿包。五步界面默认启用输出；没有该字段的 API 调用只创建报告，可在详情明确生成文件。

## 文件与交付

前缀 `/api/customers/:customerId/reports/:reportId/revisions/:revisionId/packages`：

| 接口                                    | 行为                                                     |
| --------------------------------------- | -------------------------------------------------------- |
| POST `/`                                | 202，`{audience,pdfMode?,perHostIds?,evidenceAssessmentIds?}`（audience 为 draft 或 official）；同修订同选择幂等返回同一包 |
| GET `/`、GET `/:packageId`              | 持久生成记录、所选文件逐项状态、错误、SHA-256 与字节数   |
| POST `/:packageId/retry`                | `{fileIds}`，只重试失败转换/附件，不重扫、不替换成功文件 |
| GET `/:packageId/files/:fileId`         | 校验实际字节后下载已成功文件                             |
| GET `/:packageId/download`              | 全部所选文件成功才返回完整 ZIP；否则 409                 |
| GET `/:packageId/download?partial=true` | 明确下载可用部分，文件名和清单标为不完整                 |

默认文件为 PDF、离线 HTML、完整 XLSX、`manifest.json`；逐主机 PDF 和原始评估证据可选。调整附件选择会创建另一个包，既有包记录保留。清单保存实际选择、生成操作员/时间、修订、事实哈希、逐文件状态及校验值；扫描覆盖与文件齐全分别展示。

XLSX 包含完整发现、服务器、共享关联、生命周期、整改依据及覆盖/来源；文本值显式按字符串写入，不解释为公式。PDF 摘要每评估按严重程度取前 20 条，注明全量及未展开数量；完整模式展开全部发现。HTML/XLSX 不受页面或 PDF 摘要截断。逐主机文件仅为父修订事实的派生视图，保留父事实哈希，不累计为独立扫描。原始证据必须与冻结输出哈希一致；缺失/错误独立失败，不生成空证据。

草稿文件标明未复核。正式包必须通过既有 draft → in_review → approved → delivered 流转，每次生成与下载均验证指定修订的交付记录。文件不包含令牌，不提供公开地址；所有下载继续经过客户授权。

## PDF 运行依赖

服务端使用 Playwright Chromium 打印固定离线 HTML；不连接报告中的外部资源。后端部署环境需安装浏览器和中文字体。Linux 可使用 `npx playwright install --with-deps chromium` 并安装 `fonts-noto-cjk`；桌面已有 Chrome 时配置 `REPORT_PDF_CHANNEL=chrome`。不配置 channel 时使用 Playwright 管理的 Chromium。缺少浏览器时 PDF 独立失败，HTML/XLSX 继续，部署补齐后仅重试 PDF。

相关实现 API 依据：[Playwright PDF](https://playwright.dev/docs/api/class-page#page-pdf)、[ExcelJS](https://github.com/exceljs/exceljs)、[fflate](https://github.com/101arrowz/fflate)。本轮不部署生产环境。
