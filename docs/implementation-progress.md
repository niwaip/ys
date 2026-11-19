# 实现进度

集成分支：ys/integration。规格：https://github.com/niwaip/ys/issues/1。

每条任务经测试及合并后记录提交。GitHub issue 在最终 PR 合并时关闭，集成完成状态不冒充已经发布部署。

| 任务 | GitHub | 集成状态 | 提交 |
| --- | --- | --- | --- |
| T01 | [按客户创建和查看一项资产](https://github.com/niwaip/ys/issues/2) | 已集成；npm test、npm run build 通过 | e0d643b |
| T02 | [预览并导入一份 CSV 资产清单](https://github.com/niwaip/ys/issues/3) | 已集成；npm test、npm run build 通过 | 43ae384 |
| T03 | [导入固定脚本产生的主机采集 JSON](https://github.com/niwaip/ys/issues/4) | 已集成 | `2e29a33` |
| T04 | [上传软件 SBOM 并查看组件清单](https://github.com/niwaip/ys/issues/5) | 已集成 | `47aa521` |
| T05 | [从页面执行 Trivy 软件评估并保存结果](https://github.com/niwaip/ys/issues/6) | 已集成 | `2fe7f9a` |
| T06 | [评估容器 SBOM 并关联镜像身份](https://github.com/niwaip/ys/issues/7) | 已集成 | `13e5170` |
| T07 | [基于主机资料进行有补丁依据的 Windows CVE 评估](https://github.com/niwaip/ys/issues/8) | 已集成 | `6da6f1d` |
| T08 | [导入生命周期主数据并展示 EOS/EOL 评估](https://github.com/niwaip/ys/issues/9) | 已集成 | `8a052ee` |
| T09 | [通过 Pi 对话完成一次公开 PHP CVE 查询](https://github.com/niwaip/ys/issues/10) | 已集成 | `6059ec4` |
| T10 | [通过客户对话查询和解释已有评估](https://github.com/niwaip/ys/issues/11) | 已集成 | `1743c4c` |
| T11 | [重扫后查看历史并比较评估版本](https://github.com/niwaip/ys/issues/12) | 已集成 | `084977d` |
| T12 | [按客户查看可下钻的风险 Dashboard](https://github.com/niwaip/ys/issues/13) | 已集成；审查修复中 | `173794c` |
| T13 | [生成绑定评估依据的事实报告草稿](https://github.com/niwaip/ys/issues/14) | 已集成 | `ce49de8` |
| T14 | [用 Pi 生成并校验报告叙述](https://github.com/niwaip/ys/issues/15) | 已集成；审查修复中 | `2877c31` |
| T15 | [内部复核报告并导出正式修订](https://github.com/niwaip/ys/issues/16) | 已集成 | `41c8aa1` |

运行约束：T03 起工具返回 `agent thread limit reached`，新代理及唤醒均被拒绝。主代理接手合并，仍在运行的实现代理在新工作树及分支继续后续票；无法继续保证每票全新代理上下文。独立分支、TDD、集成验证及最终审查要求保留。T03/T04 合并后 11 API 测试与构建通过，T04 工作树完整 4 浏览器流程通过。

后续限制恢复：已有代理可继续工作，但仍无法创建新代理；按独立分支继续，并由主代理处理集成。曾两次因额度中断；未完成工作保留在工作树，恢复后复验，不计作已完成。当前T15+T10整合后38项测试与构建通过；T11另3项API、构建及浏览器流程通过，已集成。

全部15票合入后的业务基线为 `8ca43a2`。Node.js 24.22.3 下48项测试、构建及15项默认浏览器流程通过；专用Pi成功替身场景由单独配置执行，默认跳过。独立Standards审查0项，Spec审查3项（报告生成文字、文字编辑、Dashboard对象筛选一致性），进入单独修复分支。此时不可计为最终验收完成。代理容量现已允许新建上下文，修复由新的独立实现代理负责。

审查修复分支 `fix/review-findings` 基于 `8f84b59`：T12明细复用概览范围解析；T14增加引用绑定的有限中文文字通道及AI成功文字要求；T15增加逐段文字输入、语法目录与错误反馈，修改仍产生待复核新稿。TDD失败证据分别为对象当前评估明细返回空、文字字段被旧schema拒绝、无文字AI提案错误成功；实现后Node24定向8项API/进程测试、构建、人工文字编辑browser及假Pi成功browser各1项通过。未调用真实Pi/provider/scanner/SSH。等待独立双轴复审和集成全套回归，尚不标最终验收完成。

集成浏览器回归另发现T12页面下钻未传已应用object范围：后端复用概览解析后，缺失object会把其他软件current加入明细。新增双对象都有current发现的浏览器场景，红灯为单对象概览instances=1而明细total=2；页面改传data.scope.object后Node24浏览器通过，断言概览唯一对象、固定assessmentRefs、明细总数及每行评估归属一致，未用first规避重复行。Node24构建通过。截图保存在修复工作树output/t12-dashboard.png（运行产物，不提交）。
