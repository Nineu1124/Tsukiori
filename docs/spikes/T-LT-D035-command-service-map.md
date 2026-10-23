# T-LT-D035：正式命令与服务对应表

实际完成：2026-10-23。交付[命令与服务表](../architecture/workspace-command-map.md)，逐项对应当前 Main 分派、真正执行服务、数据源及行为验证。区分合同覆盖与真实外部服务验收，并明确未接通 Recovery、snapshot 独立入口、Main 同步 Git 和独立配置清单等边界。

校验表内命令集合与 `workspaceCommandTypes` 一致，新增相对链接可读；逐组核对 Main 实际调用。`npm run check`、`git diff --check` 通过后提交。本项为现有行为说明，没有修改产品代码，不重复执行已通过的业务回归。
