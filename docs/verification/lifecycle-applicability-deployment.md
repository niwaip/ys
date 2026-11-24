# 生命周期适用性上线验收

2026-11-24，用户明确选择“推送并部署现有8001服务，再做线上验收”。`ys/integration` 已推送，现有PR #17包含本轮实现及审查修正。

应用版本 `5e15e22` 发布至 `http://47.116.69.153:8001/#lifecycle-materials`。远端 `npm ci`、`npm run build` 通过；沿用既有 `.runtime/serve.ts`、ys.service、专用运行身份及服务配置。数据库迁移34新增客户范围内的产品别名历史表。当前链接为 `/opt/ys/releases/5e15e22`，服务 active、enabled。

切换前停服备份数据库和配置：`/var/backups/ys/20261124T110410Z-before-5e15e22`，权限仅root；备份包含数据库、服务环境目录、systemd单元和先前release路径。上一个应用版本为 `26787b2`。服务恢复后主页200、无身份客户接口401、登录后的客户/工作台/别名接口200。

## 真实线上只读验证

现有资产YATA-POC-ECS：VM；NetBox登记平台为空；已确认OS为ubuntu 26.04，来源及确认人、时间可见。支持资料仍为unmatched、日期未知；未伪造厂商日期，未将其解释为已经停止支持。购买、维保与硬件支持不适用；VM不再作为缺购买日期的筛选结果。

真实Chrome验证桌面1440px、手机390px：OS名称版本和来源直接显示；关联OS表单无购买日期字段；设备类型/缺失项筛选、刷新回读、CSV模板下载通过；手机明细无页面横向溢出。页面异常0，接口5xx为0。未保存生产资产期限、添加产品别名、上传共同资料、同步NetBox或发起采集/评估。

截图和无凭据结构化结果位于忽略目录：

- `output/deployment/lifecycle-applicability-live-desktop.png`
- `output/deployment/lifecycle-applicability-live-mobile.png`
- `output/deployment/lifecycle-applicability-live.json`

本地完整验证：API124项通过；浏览器41通过/1个既有条件跳过；生产构建通过；Standards与Spec独立复核均无遗留实质问题。线上只有现有VM，物理服务器、网络设备、别名和扩展支持写入行为由本地真实API/浏览器回归验证，不将其冒充生产写入验收。

## 验证过程记录

读取systemd环境配置时，初版验证脚本错误地按dotenv JSON直接解析转义值，解析异常在本次工具输出中包含访问令牌。令牌未写入仓库、发布文件或验证记录；脚本已修正转义处理并屏蔽解析错误内容。保留既有登录配置，未擅自轮换凭据；需后续轮换该访问令牌。
