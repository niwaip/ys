# Pi 公开情报查询

公开情报与客户评估分别保存。页面不读取客户资产；当前客户选择不改变公开查询范围。后端按已验证操作员隔离查询历史，凭据的SHA-256仅用于内部归属，不出现在响应。凭据更换后旧查询不会自动转给新凭据；生产账号迁移需另外设计。

## 可运行适配

后端启动独立 Pi RPC 子进程，通过已登记的 `ys-public-cve` skill 调用唯一的 `ys_public_cve_query` 固定工具。扩展仅用空参数，脚本路径、完整原始问题、输出及缓存路径由后端生成。`spawn` 使用固定argv、shell=false；没有任意shell入口。每个任务独立cwd、HOME、Pi配置目录；仅传递明确的provider环境凭据。扩展自身运行在相同OS权限下，进程分离不是OS沙箱。

配置 `YS_PI_EXECUTABLE`（Pi可执行绝对路径）和 `YS_CVE_SCRIPT`（经审核的 yata-cve-research/scripts/cve_query.py 路径），可选 `YS_PYTHON_EXECUTABLE`、`YS_AGENT_ARTIFACT_ROOT`、`YS_PI_PROVIDER`、`YS_PI_MODEL`。脚本及其依赖技能包由部署环境安装并固定版本；本仓库适配输出契约2.2，未复制开发者目录、旧生产配置或私有缓存。需Python3.10+及查询来源的出站HTTPS。未配置能力返回unavailable，绝不返回假结果。

脚本固定入口为 `ask --original <完整原句> --output-dir <任务目录> --cache-dir <受控公共缓存> --timezone Asia/Shanghai`。原始result.json/report.html保存在独立任务目录；只展示经过校验的agent_view.results，隐藏样例不提升为主结果。UI保留原始条件、来源时间、覆盖缺口、缓存及stale等来源字段；不将缺修复信息改成没有补丁。HTML原件不作为可执行页面嵌入，UI仅文本渲染JSON。

RPC契约使用LF分隔JSON与请求id，区分accepted、工具开始/结束和最终完成。默认等待agent_settled；旧版本如明确以agent_end结束，可配置 `YS_PI_TERMINAL_EVENT=agent_end`。该选择需部署方对固定Pi版本验证；CLI隔离flags及真实provider兼容性尚未运行验证。仅在成功执行指定工具且取得完成事件、有效2.2结果及两份受控目录内证据文件后保存结果。模型最终文本不作为查询事实。来源partial/unavailable保持其原义。子进程60秒超时，异常/退出/输出超限明确失败并结束进程组。

## 公开接口

均需Bearer。POST `/api/intelligence/queries` `{message,idempotencyKey}` 返回202任务；不接受customerId或资产引用。GET同路径返回最近100条摘要；GET `/:id`按需返回事件和结果。相同操作员与幂等号、相同原句回放同任务；改原句409。任务开始即持久化，刷新可回读；启动将遗留running标为interrupted，不盲目重试。queued恢复执行。单API实例运行；没有跨实例worker协调或无限并发容量承诺。

任务状态与情报来源状态分别表达；所有输出固定targetAssessment=not_assessed、targetVerification=not_executed，查询不会写入客户漏洞发现。结果记录脚本契约及result.json哈希。事件仅保存受控说明，避免保存provider原始stderr/凭据；原始artifact按运行目录的保留策略备份与清理，不自动删除报告依据。

## 验证边界

使用真实PGlite、HTTP和独立Node RPC替身，未调用真实Pi/provider/查询源，也未连接服务器或扫描目标。替身仅是测试fixture，不能在正常运行配置中作为扫描结果。部署前应在获得执行指令后固定Pi/脚本版本并做真工具兼容验收。
