# 8001部署与真实页面验证

2026-11-19，用户明确要求“更新到8001，我要查看验证”。应用版本1e68dca部署到远端YS主机，访问地址：http://47.116.69.153:8001/。

远端执行npm ci及build通过，current从f3ea656切换至/opt/ys/releases/1e68dca，沿用ys.service、专用ys账号、原数据库和原登录凭据。停服后先完整备份数据库及服务配置，备份位置/var/backups/ys/20261119T074232Z-before-1e68dca，访问权限仅root。启动执行追加迁移，服务active且开机enabled；主页HTTP200，未登录客户接口401，登录后客户和新快照接口200。

真实HTTP Chrome页面验证：1440px桌面和390px手机各完成14菜单正向/逆向共28次切换，累计56次；pageerror与API 5xx均为0。三种采集入口均可打开，人工资料表单可见。没有为测试创建生产资产或执行真实采集。截图及无凭据摘要保存在本地忽略目录output/deployment/8001-collection-1440.png、8001-collection-390.png及8001-verification.json。

目前实际应用配置仍为显式本地资产模式，没有配置NetBox连接、Pi可执行程序、采集SSH引用或Trivy。可以验证新页面、手动/上传入口及旧功能；真实工具连接与采集能力仍需配置与后续授权验收。此部署不表示#18全部完成。
