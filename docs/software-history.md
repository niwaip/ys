# 软件历史、重扫与当前范围

输入版本、任务批次和当前选择分开保存。上传新SBOM或重扫不会覆盖旧结果，也不会自动替换current；在“软件历史与比较”明确选择输入版本和可选评估批次。未选择current为null；assessmentId=null表示该版本没有指定评估，不能自动找最近成功任务。允许明确指向失败批次，页面照实显示失败。

客户范围接口前缀 `/api/customers/:customerId/software/:softwareId/history`：GET摘要分页（limit1–100、offset0–1000000），GET `/current`，PUT `/current` `{versionId,assessmentId?}`，GET `/assessments/:id`按需读完整证据，POST `/compare` `{baselineId,comparedId,limit?,offset?}`。所选批次必须属于同客户同软件，current批次还须属于所选输入版本。其他目标不混入软件比较。

比较以CVE/公告编号、生态、包名、目标/路径和组件PURL身份组成实例。PURL只移除版本，保留并标准化限定符及子路径；原始重复行记录occurrences而不膨胀唯一实例数。没有可关联PURL的组件不武断跨批次合并。变化状态为added、persistent、not_observed。not_observed不是fixed，同时显示两侧版本、输入哈希、工具、库和覆盖变化。至少一侧失败、未完成或不兼容时不可比较，变化计数为null且无虚假的消失项。

首片只支持软件评估。当前指针可供Dashboard读取，但报告/对话仍绑定自己明确选择的历史引用，不受current后续变动影响。迁移11保存客户范围current，历史记录不删除。
