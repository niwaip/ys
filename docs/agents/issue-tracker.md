# Issue tracker: GitHub

本项目的规格和任务由用户指定的 niwaip/ys GitHub Issues 管理，使用 gh CLI。

- 发布任务：每项一条 issue，任务的 blocking 关系使用 GitHub 原生 issue dependencies。
- 规格为父 issue，已发布任务通过 sub-issue 关系关联。
- 开发使用 ys/integration 集成分支及一个 PR；PR 中引用规格和已完成任务，合并时由 GitHub 关闭。
- 未合并前不得将未完成任务或规格标记关闭。只有验收通过的工作可以写入关闭引用。
- 不对参考仓库发布项目业务 issue。

PRs as a request surface: no.
