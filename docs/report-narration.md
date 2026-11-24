# T14：绑定事实的 Pi 受控报告叙述

报告已有固定事实草稿后，可发起后台AI叙述任务。模型组织受控段落的顺序、措辞、密度及可选摘要/建议；事实正文由服务端模板插入，模型在 text 字段提交引用绑定的有限中文句法文字，事实占位符由服务端插值。生成成功只创建新draft，仍走T15提交复核、通过、正式交付；不会改变factHash、原评估或旧交付。失败不覆盖原报告，保留固定模板路径与诊断。

## HTTP与持久任务

沿用操作员Bearer及URL customerId授权。以下前缀为 `/api/customers/:customerId/reports/:reportId/narrations`：

| 请求 | 行为 |
| --- | --- |
| POST `/` `{baseRevisionId,idempotencyKey}` | 202：绑定同客户同报告明确修订和服务端factHash，保存queued任务；不接受客户端facts/prose |
| GET `/` | `{items}`，最近100个任务，含状态、事件、fallback及结果修订引用，不含访问令牌 |
| GET `/:jobId` | 同客户同报告范围的持久任务详情 |

相同客户/报告/幂等键复用同一任务，baseRevision/factHash不符409；失败终态不自动重试，新请求需新键。任务状态为queued/running/succeeded/failed/unavailable/timed_out/interrupted。失败的fallback=true表示原事实草稿保留，不代表AI成功或通过复核。任务记录绑定baseRevisionId、factHash、事件及proposalHash；成功返回resultRevisionId。

worker从持久队列处理任务，依据保存的操作员不可逆hash重新核验当前客户授权；不持久化令牌。提交后授权失效、模型输出无效、工具失败或生成期间已有新人工修订，任务失败且不覆盖当前报告。重启将运行中任务记为interrupted，已排队任务继续执行；服务停止会中止本次执行，终态不自动重跑。

## Pi固定能力与校验

服务端传给Pi的输入仅有选定报告的范围、统计、覆盖缺口、保护段落目录和绑定ID/hash；不发送全客户列表、其他报告、原始执行输出、凭据或任意后端访问能力。模型可用工具只有：

1. `ys_report_facts`：固定脚本读取绑定输入，写已读凭据。
2. `ys_report_proposal`：固定脚本在任务输出目录写proposal.json，先验证已读凭据。文件路径、baseRevisionId和factHash由服务端绑定，不由工具参数选择。

`tools/pi/skills/report-narration/SKILL.md`规定这一顺序，扩展/脚本为仓库内固定文件。共用 `runPiCapability` 使用隔离HOME/配置目录、关闭任意内置工具与外部扩展，仅加载指定skill和工具，并验证请求接受、工具调用开始/结束编号和终态；只有模型的最终文字不会被当作报告输出。

后台再次校验提案绑定、受控schema与保护段落集合。虚构引用、额外CVE/统计/日期/自由事实正文、删除覆盖或来源段落、事实hash偏移均失败。可选summary/recommendations各最多一个、没有factRef；保护正文仍由服务端生成；各段可带 text 文字通道。AI成功提案必须含引用说明及建议句，不能只返回枚举。有限句法、引用条件和页面编辑见 [报告文字通道](reports.md#受控文字通道)。不接收模型数字或修复结论。之后复用 `ReportReviewService.revise` 新建draft；过期baseRevision触发冲突，避免异步生成覆盖人工新稿。正式审批/交付接口与固定模板草稿完全相同。

## 本地配置与验证

`YS_PI_EXECUTABLE`配置Pi，`YS_PI_PROVIDER`/`YS_PI_MODEL`可选，`YS_PI_TERMINAL_EVENT`按已配置CLI协议选择agent_settled或agent_end。`YS_PI_TIMEOUT_MS`限制报告叙述任务，默认60000毫秒。`YS_AGENT_ARTIFACT_ROOT`下的reports子目录保存隔离任务请求、已读凭据及提案；这些运行资料不提交仓库。报告能力使用仓库固定Node脚本，不需要公开CVE查询的YS_CVE_SCRIPT。

默认浏览器套件显式无Pi，验证unavailable/fallback；成功browser只在单独配置中启动仓库假Pi，绝不调用真实provider：

```sh
YS_REPORT_BROWSER_FIXTURE=1 YS_BROWSER_API=http://127.0.0.1:3124 PLAYWRIGHT_CHANNEL=chrome npm run test:browser -- --config playwright.narration.config.ts
```

端口4274/3124，数据在`.data/browser-narration`。普通 `npm run test:browser`跳过这个专用成功spec。API通过注入固定输出验收成功、越界提案、超时、并发新稿及重启；进程契约通过真实固定extension/script配合本地假Pi验证。以上自动化套件不连接真实provider；YS主机的真实Pi验收另见 [生产环境报告叙述验证](verification/pi-report-narration.md)。其他CLI版本仍需核对终态与工具协议。
