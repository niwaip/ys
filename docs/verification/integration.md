# 集成验收

日期：2026-11-19。业务提交：`8dbeb24e9a3a888d81cb08512befb9950bba31cf`。规格 #1、任务 #2–#16，集成分支 `ys/integration`，PR #17。

## 执行证据

Node.js 24.22.3；API通过实际HTTP及隔离PGlite执行SQL，工具边界使用固定本地进程，不调用真实provider或扫描器。

| 检查 | 结果 |
| --- | --- |
| `npm exec --yes --package=node@24 -- npm test` | 19文件、48项通过；最终后端及共享契约提交b4b537f，后续仅前端范围参数、浏览器断言和文档变化 |
| `npm exec --yes --package=node@24 -- npm run build` | 最终8dbeb24通过，TypeScript及Vite构建 |
| `PLAYWRIGHT_CHANNEL=chrome npm exec --yes --package=node@24 -- npm run test:browser` | 最终8dbeb24：15通过、1专用场景按配置跳过 |
| 独立假Pi成功配置 | 1通过；真实仓库extension/script加本地假Pi，报告实际文字、新草稿、事实hash不变、禁止未经复核下载 |
| 独立最终审查 | Standards 0项、Spec 0项未解决；见final-review.md |

独立成功配置命令：

```sh
YS_REPORT_BROWSER_FIXTURE=1 YS_BROWSER_API=http://127.0.0.1:3124 PLAYWRIGHT_CHANNEL=chrome npm exec --yes --package=node@24 -- npm run test:browser -- --config playwright.narration.config.ts
```

## 审查修复证据

- 原AI只能选择模板且人员无法编辑实际文字：新增共享有限句法、事实引用目录及逐段文字编辑。非法结论、虚构引用、无依据建议拒绝；成功生成实际句子并保留原事实，形成必须重新复核的draft。
- Dashboard明细与概览对象解析不一致：复用同一范围解析，验证当前指针、错配、重复、时间及客户隔离。
- 浏览器进一步发现页面漏传已应用object，导致概览1条而明细2条。双对象红灯复现后修正传参，最终验证对象、实例总数、批次引用及逐行归属一致。

## 实际边界

未部署、未SSH、未连接现有服务器、未执行真实客户扫描、未调用真实Pi/provider。Pi CLI和外部CVE脚本的真实环境兼容性、实际PostgreSQL服务、容量与多进程部署未在本轮验证。未配置工具时明确不可用，不用样例结果代替真实执行。

首片支持范围仍按各功能文档：CycloneDX JSON 1.4–1.6；Windows规则首片为Server 2022 LTSC/20348/x64且人工规则部分覆盖；生命周期为带来源CSV；客户对话/当前指针/历史比较首片为软件范围；AI文字为有限可组合句法；正式交付为HTML。NetBox不承担本地资产主数据。Dashboard的对象/目录/趋势上限明确披露，不承诺无限规模。

临时工作树均在提交合入后归档；截图运行产物保留于本地 `output/verification/dashboard.png`，不提交客户资料、凭据或缓存。
