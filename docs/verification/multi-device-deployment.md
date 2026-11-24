# 多设备采集发布验证

2026-11-23，用户授权“更新到ys主机”。应用843e997已部署至YS:8001，current指向`/opt/ys/releases/843e997`，ys.service active；远端npm ci及构建通过，启动追加迁移成功。

切换前停服备份数据库及服务配置：`/var/backups/ys/20261123T150141Z-before-843e997`；原版本9518887、运行配置及采集授权保留。

真实Chrome登录验证统一配置、取消旧Windows/CSV顶部导航、VM分类锁定、手动CPU字段、Windows路径不出现连接执行、刷新及390宽无横向溢出。页面异常0、API 5xx为0。已有唯一资产YATA-POC-ECS在NetBox为VM，按原生身份锁定属预期；未为验收创建资产或写入观测、基线及外部主数据。

本地非入库证据：output/deployment/multi-device-live-result.json及multi-device-live-{1440,390}.png。网络设备等类别的创建及录入、采纳/拒绝流程由发布前隔离端对端验证覆盖，不冒充生产写入验收。
