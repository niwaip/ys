# 生命周期适用性实施与验证

2026-11-24。范围：#60、#61、#62、#63、#64；设计基点 `0c207cf`。

- VM只关注OS，不将购买、维保、硬件支持列为缺失或未知风险。物理服务器与网络设备保留OS、型号、购买、维保；存储与电源不强制OS。筛选在服务端分页前完成。
- 登记平台与确认OS分别保留产品、版本、来源和时间；确认基线附带操作者、快照、逐字段来源。只有观测没有确认基线时，不显示为已确认OS。来源冲突阻止确定性OS期限判定，不修改NetBox平台。
- 产品别名在客户范围内显式配置并保留配置人、依据及历史。匹配保留原始产品名；多个目标或多个厂商记录保持冲突，不自动选择最新批次，不猜版本。
- 分类CSV可以增加 `supportTier=standard|extended`；保留原文、厂商阶段及来源。旧CSV继续保留原始EOS/EOL含义，不推测缩写。默认标准支持；扩展支持关联须有 `entitlement` 适用依据。标准支持截止仍展示。
- 页面与风险读取共用支持资料解析及规则选择。资料导入、关联和别名变更不调用评估；历史风险视图保持固定。
- 工作台分开显示覆盖与当前期限风险，直接显示OS名称版本、采用期限及风险，VM入口突出OS，手机明细采用卡片；变更历史默认收起。

## 公开接口增量

`GET /api/customers/:customerId/lifecycle/aliases`：读取本客户的产品别名配置历史。

`POST /api/customers/:customerId/lifecycle/aliases`：提交 `category`（os/device/hardware/software）、`alias`、`product`、`basis`；服务端记录操作者和时间。匹配仅应用明确的一步别名对应，不推导版本或名称链。

生命周期资产的 `os` / `device` 关联可增加 `supportTier` 和 `entitlement`；省略类型按标准支持兼容。扩展支持缺依据返回400。原有批次、客户隔离、乐观并发及变更历史机制沿用。

`GET .../lifecycle/workspace` 增加 `applicability`、`osIdentity`、专属期限风险、支持阶段及风险状态。摘要仍是本客户全部在管资产；列表按筛选后分页。共同CSV通过既有 `POST .../lifecycle/batches` 直接校验导入，不抓取厂商资料。

## 验证

- `npm test`：35个文件，124个测试通过。
- `PLAYWRIGHT_CHANNEL=chrome npm run test:browser`：41通过，1个既有Pi成功路径用例跳过；配置原有的两个集成文件仍排除在默认套件外。
- `npm run build`：通过；保留既有客户端包体积提示。
- 新增API用例覆盖VM适用性、确认前后OS、平台缺失/一致/冲突、客户隔离、显式别名及歧义、标准与扩展支持、无依据拒绝、无自动评估及旧视图固定。
- 浏览器覆盖Ubuntu VM、别名保存、扩展支持依据、刷新、来源冲突、物理服务器维护入口，以及网络设备CSV与购买/维保流程。
- 截图：`output/deployment/lifecycle-applicability-desktop.png`、`output/deployment/lifecycle-applicability-mobile.png`（本地验证输出，不提交）。

本轮只实施并本地验收，未部署生产或修改实际客户资料。

## 独立审查与修正

以 `0c207cf...HEAD` 为范围，按 code-review 分别检查 Standards 与 Spec。初审发现分批标准/扩展资料的标准截止缺失、专属期限风险未在明细显示，以及两处风险计算重复。`fd3c427` 已修复：标准阶段跨批次保留并显式表达歧义；明细显示维保风险与使用年限到期；日期推导、分类和风险分级共用函数。两路复核均无遗留实质问题。

完整浏览器复跑仍为41通过、1跳过。API并行于浏览器执行时，既有Trivy进程测试的一次2秒退出用例被判为超时；单独重跑该文件7项全部通过。增加分批支持回归后，API总数为124项。

最终串行 `npm test`：35个文件、124项全部通过（85.25秒）。工作区构建与浏览器完整回归均已通过。

用户随后授权推送及部署8001；应用5e15e22已发布并完成真实线上只读验收，见 [上线验收](lifecycle-applicability-deployment.md)。
