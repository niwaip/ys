---
name: ys-public-cve
description: 通过后端固定工具查询公开 PHP CVE 或单个 CVE，保留来源和覆盖缺口。
---

调用一次 ys_public_cve_query，参数为空对象。后端已绑定完整原始问题、输出目录及只读固定脚本；不得自行改写或扩大查询范围。

只依据工具返回说明查询结果和覆盖缺口。不访问客户资产，不执行 PoC。工具失败时说明失败，不从记忆编造最新 CVE。查询结果始终是 not_assessed / not_executed。缺修复资料表示未知，不表示没有补丁。完成工具调用后结束本次任务。
