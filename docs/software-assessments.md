# 软件 Trivy 后台评估

客户 → 软件对象 → SBOM 输入快照 → 评估任务 → 发现和原始证据。任务只读取提交时明确的输入版本，不自动改为最新资料；报告、Dashboard及后续功能必须持有具体任务编号。人工报告复核不改变评估判定。

## 运行配置

默认 Trivy 未配置，任务进入 unavailable，绝不展示模拟成功。真实可执行文件、可写数据库缓存及数据库源联网能力由运维明确设置：

- `YS_TRIVY_EXECUTABLE`：可信 Trivy 可执行文件绝对路径。
- `YS_TRIVY_CACHE_DIR`：专用可写缓存绝对目录，首次扫描会自动获取 `db/trivy.db` 及 `db/metadata.json`。Java相关资料缺失可能降低覆盖或执行失败。
- `YS_TRIVY_TIMEOUT_MS`：版本读取及扫描各自的期限，默认120000，允许50–3600000毫秒。

仅此配置不会主动发起扫描；用户在页面提交后，后台才执行。每次新任务先使用 Trivy 原生 `image --download-db-only` 检查并更新漏洞库，成功后再扫描；更新失败、超时或中断则停止，不回退旧库。更新默认300000毫秒，可通过 `YS_TRIVY_DB_UPDATE_TIMEOUT_MS` 独立配置。数据库源按 Trivy 默认值，可用 `YS_TRIVY_DB_REPOSITORIES` JSON数组配置公开 OCI 源优先顺序（例如官方 `ghcr.io/aquasecurity/trivy-db:2`）；不接受客户端提供源或参数。扫描本身仍不联网补充依赖识别。软件输入只来自数据库中的客户SBOM，无客户提供的可执行文件/argv/路径。

固定契约依 [Trivy SBOM CLI](https://trivy.dev/docs/latest/references/configuration/cli/trivy_sbom/) 实现：独立临时工作目录、空配置/ignore文件，`shell:false`，参数数组调用 `--version`，再执行原生数据库更新，最后 `sbom --format json --scanners vuln --list-all-pkgs --no-progress --skip-db-update --skip-java-db-update --offline-scan --skip-version-check --exit-code 0 --config <受控路径> --ignorefile <空文件> --cache-dir <运维缓存> --output <受控报告> <受控输入>`。环境不继承 TRIVY_*、凭据及应用配置；保留基本PATH、临时HOME/TMPDIR、LANG。第三方SBOM识别仍有[官方说明的准确性限制](https://trivy.dev/docs/latest/target/sbom/)。

保存版本输出、实际argv、开始/结束、stderr、退出码、信号、原始报告与SHA-256、执行前后DB元数据快照。版本与schema不兼容时失败，不用空结果代替。输出/报告上限默认5MB；可通过服务器配置设置1000–20000000字节。临时文件结束后清理；证据保存在数据库。超时发送TERM、200毫秒后KILL；Unix终止子进程组，不自动重试。

## API 与身份

均需 Bearer，客户URL权限服务端验证。接口解析严格，不接受body额外客户/命令字段。

| 请求 | 行为 |
|---|---|
| POST `/api/customers/:customerId/assessments` | `{softwareId,versionId,idempotencyKey}`，202返回已持久排队任务 |
| GET `/api/customers/:customerId/assessments?limit=50&offset=0` | `{items,total,limit,offset}`，limit1–100/offset0–1000000；摘要含nullable findingCount、coverage、database，不加载原始报告或完整发现 |
| GET `/api/customers/:customerId/assessments/:assessmentId` | 任务全部输入/状态/错误/结果与原始执行证据 |

幂等键1–200字符，客户范围唯一。相同输入和同键回读原任务（replayed=true），包括失败、超时和中断；同键用于另一输入409，不创建新评估。新一次主动评估使用新键。界面重复提交沿用当前请求键，“新建评估请求”明确生成新键。跨客户或不属于软件的输入404，非法请求400，无凭据401，未授权客户403。

## 状态、恢复及覆盖

单后端进程内持久队列：queued → running → succeeded / failed / unavailable / timed_out / interrupted。排队与开始均先落库，浏览器退出不终止任务；应用关闭会中断执行中的工具并保存状态，未开始任务保持queued。启动恢复queued；遗留running标记interrupted，说明上次结果未知，禁止盲目重扫。终态不可被重复请求改写。当前不支持多后端实例共享worker（启动恢复基于单后端假设）。

只有兼容 `SchemaVersion:2` 和有效Results结构才能产生result；坏JSON、非零退出、超时、缺失工具/库均无有效result。“尚无结果”不等于零发现。Results为空时outcome可为no_findings，但coverage为unknown；页面同时说明覆盖。未知版本、无PURL、无法匹配输出包或空输入清单均阻止声明完整覆盖。

每条发现保留目标/包生态/安装版本/工具漏洞标识/严重程度/工具给出的FixedVersion/来源和完整原始漏洞对象；不把相同CVE在不同组件或目标中的实例合并。componentId仅在PURL（若有）与名称/安装版本一致并唯一时绑定；不匹配保留null与覆盖缺口。适用性为tool_reported；FixedVersion缺失不代表无补丁。

coverage的complete_for_declared_input仅表示所有声明组件存在可核实包证据（已知版本/PURL、身份一致、无歧义、DB元数据执行期未变），不代表整个环境安全。partial/unknown与发现数量分开；第三方SBOM限制一直显示。

DB的UpdatedAt、NextUpdate与扫描时刻独立保存，缺失/无效日期为unknown；完成时间超过NextUpdate为stale。DB元数据前后变化单独标记。过期库仍可产生带明确警告的历史结果，不能称为最新扫描。

## 扩展与验证

`AssessmentService.get(customerId,id)` 返回完整 `Assessment`；`list(customerId,{limit,offset})` 返回 `AssessmentPage` 摘要。DTO在 `packages/contracts/assessments.ts`，模块通过 `AssessmentsModule.register(executor)` 导出service。多个消费者复用同一个DynamicModule引用，不重新注册worker。`TrivyExecutor.execute({content,contentHash},signal)` 是可替代工具边界；`ProcessTrivyExecutor` 是实际进程适配器。后续容器/主机需使用独立目标类型及解析语义，不把软件发现自动串入其运行实例。

测试使用明确标记的固定输出和 `tests/fixtures/trivy/fake-trivy.cjs` 子进程替身，未执行真实Trivy或扫描。浏览器配置只在隔离测试目录生成假可执行文件/假数据库，不能复制到真实运行配置。`PLAYWRIGHT_CHANNEL=chrome npm run test:browser -- --config playwright.assessments.config.ts` 可单独验收本片，默认浏览器套件同样配置替身。真实工具及已安装版本兼容性须后续单独授权验证。

数据库更新使用相同隔离环境及空配置，原生命令包含 `--no-progress --skip-version-check --disable-telemetry --config <受控路径> --cache-dir <缓存>`。保存更新开始/结束、退出码、信号、stderr及更新前后元数据，页面展示更新阶段及证据。归一化扫描的DB前后时间从更新完成后开始计算，正常更新不被误判为扫描期间改变数据库。Trivy检查认为已有库仍有效时可能不下载，成功表示原生检查完成，不保证本次发生下载。历史任务及幂等重放保持原证据；重新扫描创建新任务才再次更新。参考：[Trivy 数据库管理](https://trivy.dev/docs/latest/configuration/db/)。
