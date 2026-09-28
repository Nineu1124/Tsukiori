# T-LT-D006：凭据异常输出矩阵

实际完成：2026-09-28。Windows、Node 24.11.1、pnpm 11.9.0。

| 边界 | 已验证场景 |
| --- | --- |
| Codex 子进程 | RPC 错误、请求超时、分块 stderr 后异常退出、待处理请求拒绝 |
| Claude 子进程 | 任意 stderr 正文、嵌套失败结果、退出回调 |
| Direct API | 创建/迭代/完成失败、探测超时、主动取消、错误元数据 |
| 公共分类 | 嵌套与循环原因、异常 getter、超长及无固定格式的合成秘密 |

命令：`node --test tests/interactive/runtime-failure-matrix.test.mjs tests/interactive/runtime-error-boundary.test.mjs tests/interactive/api-runtime.test.mjs`，15/15 通过。仅测试改动；复用 D005 已构建的产物。提交前执行 `npm run check`、`git diff --check`。

请求超时与主动中断分别有稳定类别，原始错误、堆栈和事件中不出现合成秘密。实际子进程测试避免只验证字符串工具函数。未使用真实密钥或外部 Provider，不把这份矩阵当作所有 Runtime 版本的兼容性证明。
