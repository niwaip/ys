# 远端 HTTP 菜单空白修复

2026-11-19（Asia/Shanghai）；远端 http://47.116.69.153:8001/，修复版本 `f3ea656`。

## 复现与根因

实际Chrome登录后依次点击资产、概览、历史、Windows补丁评估，最后一步主内容和菜单消失；捕获 `crypto.randomUUID is not a function`。截图留在本地运行产物output/menu-smoke/failure-3.png。localhost被浏览器视为可信上下文，旧测试未覆盖真实HTTP下缺少randomUUID的条件。

将这一条件写入tests/browser/navigation.spec.ts：显式移除randomUUID，按实际菜单点击并检查主内容与pageerror。修复前该用例在Windows补丁评估稳定失败。前端17处调用集中到requestId()，使用HTTP环境仍可用的crypto.getRandomValues生成UUID v4，不使用Math.random；后端身份、权限及幂等契约不改变。

## 验证

- Node24构建通过。
- 完整默认浏览器16通过、1专用成功场景按配置跳过；独立假Pi成功场景另跑1通过。
- 新回归在没有randomUUID时覆盖全部13菜单正反切换，并执行新建Windows评估请求。
- 更新远端后，真实HTTP桌面1280px与手机390px各点击26次，合计52次；主内容均存在，pageerror为0。未用浏览器注入polyfill掩盖部署问题。
- systemd服务active，current指向/opt/ys/releases/f3ea656；原数据目录和凭据保留。菜单测试只读页面，不执行真实扫描或模型调用。

远端只读烟测脚本及脱敏结果在本地output/menu-smoke/debug与results-1280.json、results-390.json；截图为success-1280.png和success-390.png。运行产物不提交，脚本从受限本地配置读取凭据，不输出令牌。

## 项目实际状态

T01–T15的首片实现与本地计划验收已完成，PR17尚未合并。部署后的运行验收仍持续进行，本修复弥补HTTP条件的测试遗漏。

远端已启动前后台，但本次核实YS_PI_EXECUTABLE、YS_CVE_SCRIPT、YS_TRIVY_EXECUTABLE均未配置；真实Pi/模型、公开查询脚本、Trivy及数据库资料的联调未完成。真实客户输入和完整报告交付的验收未进行；不能把固定替身测试表述为真实能力已就绪，也不能把任务实现完成表述为全部生产工作完成。
