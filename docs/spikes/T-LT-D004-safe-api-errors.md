# T-LT-D004：去掉 Direct API 错误正文

实际完成日期：2026-09-21，按本次要求提前执行；原计划日期：2026-09-24。起点：`d9842b2`。环境：Windows，Node 24.11.1，pnpm 11.9.0。

## 问题与修改

原处理只截断 Provider 错误正文，未阻止正文中的密钥进入 Runtime 事件和 Transcript。同步抛错、异步迭代抛错也没有经过统一的错误出口。

新增固定错误类别和中文提示。Provider 错误只在内存中用于分类，不携带原始 message、cause、响应正文或附加字段向外抛出。分类覆盖认证、限流、额度、上下文、超时、中断和网络异常，未知错误使用统一提示；嵌套字段读取有深度限制和循环保护。

API Runtime 的请求创建、流读取和错误完成事件共用该出口。成功消息不再携带 errorMessage，历史消息转换也不再带出该字段。Workspace 在异步失败和同步调用失败处再次限制错误输出，避免替换客户端后绕过边界。

## 验证

- `pnpm --filter @tsukiori/desktop build`：通过。
- `node --test tests/interactive/api-runtime.test.mjs tests/interactive/provider-registry.test.mjs`：17/17 通过。
- `node --test --test-name-pattern='API failures never expose' tests/interactive/interactive-workspace.test.mjs`：1/1 通过。
- `pnpm run test:interactive`：构建 21/21、交互回归 93/93 通过。
- `pnpm run typecheck`：34/34 Turbo 任务通过。
- `node --test tests/security/*.test.mjs`：6/6 通过。
- `npm run check`、`git diff --check`：提交前通过。

专项测试使用合成凭据及其 URL 编码形式，没有联系真实 Provider。覆盖流工厂同步异常、异步迭代异常、SDK 错误事件、失败完成消息和客户端同步抛错；正式 Workspace 路径检查外发/轮询事件、Renderer Snapshot、诊断摘要、状态主文件、备份、Transcript 和重启后的状态，均不含原始错误正文。

分类回归发现 ECONNRESET 没有被识别为网络错误，已补齐相应错误码并重跑通过。认证、限流、额度、上下文、超时、中断、嵌套原因、循环引用及异常 getter 均有验证；中断行为不被错误正文中的认证字样覆盖。

## 结论与边界

D004 验收通过：新 Direct API 请求的错误正文不会通过上述错误出口进入事件、状态或会话记录，同时保留可定位的错误类别。

该修改针对错误输出，不修改正常回复内容，也不清洗磁盘上已经存在的历史错误记录。Codex/Claude 等子进程的 stderr 仍由 D005 处理，不能把本项当成所有 Runtime 脱敏工作均已完成。
