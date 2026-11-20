# YS真实Pi报告叙述验收

日期：2026-11-21（Asia/Shanghai）。网站应用版本仍为 `de0de61`，本次连接现有Pi运行时，未修改业务代码或扫描判定。

## 运行配置

复用YS主机已安装的Pi 1.5.2，以及已有且实际请求成功的 `qwen-poc / qwen3.7-plus`。原交互配置的默认provider/model与models.json不一致，因此网站显式指定这组已验证模型；没有更改原root交互设置。

- 固定运行时副本：`/opt/ys/pi`，入口 `/opt/ys/pi/run`，由root维护，网站以ys用户执行。
- 仅选定provider的模型配置：`/etc/ys-pi/models.json`，root:ys、0640，上级目录0750。配置含凭据，不提交仓库、不写入日志或模型输入。
- 每个任务保持隔离HOME和PI_CODING_AGENT_DIR；入口仅允许 `/var/lib/ys/agent/*/pi`，只链接指定模型配置，不加载root的MCP、扩展、历史、设置或skills。
- 网站继续通过仓库固定extension及skill控制工具，关闭内置工具、MCP和配置发现。`PI_OFFLINE=1`关闭启动更新，`PI_TELEMETRY=0`；模型API请求仍联网。
- service.env指定provider/model、180000毫秒超时及 `agent_settled` 终态。修改前备份 `/etc/ys/service.env.before-pi`；回退该文件后重启ys即可关闭网站Pi接入，已经创建的报告修订仍保留。

第一条真实任务 `39b6a9a2-5b5f-4e5d-8236-8caf9a7a0246` 因配置最初位于不可穿越的 `/etc/ys` 下失败，fallback=true，原报告保留。调整为专用目录后，以新幂等键明确提交第二条任务；没有自动重试或隐藏失败记录。

## 真实结果

- 报告：`5a89d39f-b68f-43ea-b741-850b1bafca2a`。
- 基础修订1：`36dfe769-a648-4f5f-8170-d9e117ebcde3`，原状态in_review。
- 成功任务：`8b2a705d-5cbf-4a80-b306-0392d4faf0ff`，约36秒，succeeded、fallback=false。
- 事件依次包含accepted、ys_report_facts开始/完成、ys_report_proposal开始/完成、agent_settled、validated。
- 新修订2：`9ff451f8-9071-423e-b618-170125c1fbd3`，draft。
- 新旧事实SHA-256均为 `53204106437b27b019389596dcc682a36bf0ddca34171d1d4d96f6d6f72aa3b4`。
- 提案SHA-256：`7fe70dd9b68b55a3a1ebe70e9df200385fa5d4f79f7167317261533a90e6aaa7`。

后端真实校验通过后才新建修订。19,030条工具记录及3,635个不同CVE标识、partial覆盖和tool_reported判定继续来自冻结事实。没有批准、正式交付、修改资产基线或写入NetBox。此次验证证明这一版本与模型的报告工具链可用，不代表所有Pi能力或任意模型均已验证。

查看入口：YS:8001 → 风险事实报告 → 报告历史 → 上述报告 → 最新修订。新AI草稿仍需内部复核。
