# T-LT-D005：Runtime 错误输出边界

实际完成：2026-09-28。环境：Windows、Node 24.11.1、pnpm 11.9.0。

Codex 的失败请求曾拼接 stderr，Claude 对未知格式的秘密只做有限正则替换，错误结果也能直接带出正文。现在共享固定类别和中文提示：嵌套错误只用于分类，正文不进入抛出的错误、退出回调或失败事件。桌面会话入口再次处理 Runtime 错误和完成事件，避免状态和 Transcript 接收原始错误。

验证：`pnpm run build` 21/21；`node --test tests/interactive/*.test.mjs tests/claude-adapter/*.test.mjs` 109/109；`pnpm run typecheck` 34/34。提交前执行 `npm run check`、`git diff --check`。

新增真实子进程测试分别经过 Codex/Claude 客户端，将任意合成秘密写入 stderr 后退出，确认异常、事件和退出回调均不含该值；嵌套 Claude 失败结果保留认证失败提示。原测试要求出现 REDACTED 占位符，现改为验证固定提示，原有秘密排除断言保留。

本项处理错误输出，不改写正常回复和工具内容；未调用真实 Provider，未清洗既有历史记录。后续异常矩阵由 D006 补充。
