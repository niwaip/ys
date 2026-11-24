# 单页 Dashboard 验收记录

2026-11-23；规格 #34，任务 #35–#38。生产应用版本 `6dc933b`。

## 实现

首页四组数字卡片：资产规模、CVE 概要、生命周期风险、评估覆盖与待处理。详细对象、观测分页、历史趋势和证据保留在独立风险结果页；固定链接按客户存储读模型，刷新不重新解析 current。生命周期等级按资产最高风险归类，待处理按风险项计数，接受风险不消除等级。未知覆盖和库时间分别显示。

## 自动化

- `npm run typecheck`、`npm run build` 通过。
- `npm test`：30 文件、98 项通过。
- 审查修正后 `npx vitest run tests/api/dashboard.test.ts`：6 项通过。
- `PLAYWRIGHT_CHANNEL=chrome npx playwright test --reporter=line`：30 项通过、1 项跳过。跳过的是需要隔离 Pi fixture 配置的报告草稿成功用例。
- `PLAYWRIGHT_CHANNEL=chrome npx playwright test --config=playwright.container-runtime.config.ts --reporter=line`：4 项通过。
- 新增端到端覆盖：跨刷新和新增对象固定范围、跨客户拒绝、首屏无详情、资产和覆盖跳转、等级匹配记录分页回读、固定生命周期处理筛选、混合等级资产按最高等级下钻、手机无横向溢出。

## Standards

以 `4437449` 为基点，两名独立审查代理分别审查规范和需求。规范审查初次发现2项：未使用的 kind URL 筛选与 findings 不一致、迁移28未追加至数组末尾。已删除无入口的 kind 筛选并移动迁移；复核无新增可操作违规。

## Spec

需求审查初次发现3项：固定 scope 页设备按钮可能重新解析 current；生命周期等级卡与下钻资产群不一致；首页缺少覆盖未知。已隐藏固定范围的实时范围按钮、增加 assetLevel 最高等级过滤、增加两张未知卡片与共享状态筛选。新增回归通过；复核无新增实质缺陷。

审查最终未解决项：Standards 0，Spec 0。

## 生产发布与验证

- 地址：`http://47.116.69.153:8001/#dashboard`。
- `/opt/ys/current` → `/opt/ys/releases/6dc933b`，systemd `ys` 为 active。
- 发布前备份：`/var/backups/ys/20261123T093420Z-before-6dc933b`，含数据库、服务配置和先前版本路径。
- 迁移28为新增 dashboard_scopes 表，发布保留 Docker 授权和 ys 的 docker 用户组。
- 线上1440×900：文档高900px，首页表格0、选择器0；四组均在首屏。
- 高危卡片4,114条，与跳转固定范围明细总数一致；刷新仍一致。
- 待处理卡片进入固定生命周期 view、active/pending 筛选，刷新保留。
- 主机、软件和镜像资产卡片均跳转对应页面。
- 390宽布局无横向溢出。验证流程浏览器异常0、HTTP 5xx为0。
- 截图（忽略目录）：`output/deployment/dashboard-onepage-live-1440.png`；手机另外以独立390视口复核，避免桌面窗口调整尺寸后的整页截图拼接伪影。

线上验证未启动扫描、切换评估指针或采纳基线。打开概要正常保存固定展示读模型。当前固定链接无自动到期策略，需监控存储增长；布局目标为1440×900，较矮桌面和手机允许纵向滚动。
