# T-LT-D025：Claude Adapter 纳入 CI

实际完成：2026-10-16。Windows / Node 24.11.1，Claude 2.1.226 离线合同。

windows-ci 增加独立 Claude Adapter contracts 步骤，执行既有 npm run test:claude-adapter，失败可在独立步骤中定位。覆盖发现与版本限制、Provider 隔离、原生认证、权限、中断、恢复、分支、MCP 显式配置及下一轮重读、stream-json 归一化。测试只调用本地夹具，不使用真实账号或 CI Secret。

本机运行 `node --test tests/claude-adapter/*.test.mjs`：16/16，约 5.7 秒。依赖构建已在前序改动完成，CI 脚本自身包含 build。`npm run check`、`git diff --check` 通过后提交。此处记录本地结果，不把推送当成远端 Actions 已通过；其余多行步骤的失败传播由 D026 接续处理。
