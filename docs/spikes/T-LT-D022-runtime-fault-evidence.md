# T-LT-D022：双 Runtime 故障证据

实际完成：2026-10-16。Windows，Node 24.11.1；OpenCode 1.18.4、Codex 0.146.0 离线 CLI。

给故障夹具添加可选生命周期记录，只保存请求计数、注入标记、信号名称和退出码。双 Runtime 回归现在先核验注入记录及真实 Handle 退出，再检查会话健康。请求异常保留固定原因类别 connection_closed / connection_refused / request_timeout / request_failed，外部消息仍为固定文本，不保存原始异常、URL、请求正文或认证头。

复现证据：原回归 1/2 通过，等待 interrupted_runtime 超时。增加观测后仍为同一已知失败；输出 requestFailure=connection_closed，生命周期只有 prompt_received 1–5，没有第六次请求、注入标记或退出事件；Handle=ready，Session=idle/error。请求失败没有证明进程崩溃，原失败不能靠增加等待时间解决。

独立子进程合同测试确认夹具在第二次请求确实触发退出：crash_injected(code=23)，随后父进程收到 exit(code=23, signal=null)。没有 OS 信号是本例 process.exit 的预期结果。诊断文件不含输入 canary 或认证数据。

验证：`tsc -p packages/adapter-opencode/tsconfig.json` 通过；`node --test tests/dual-runtime/fault-injection.test.mjs tests/opencode-adapter/*.test.mjs` 18/18；`node --test tests/dual-runtime/dual-runtime-e2e.test.mjs` 保留已知 1/2 失败并给出上述证据；`npm run check`、`git diff --check` 通过后提交。

本项完成的是诊断能力，未把已有失败标为修复，也未跳过失败断言。D023 接续处理请求在到达注入点前断开的根因；G-LT-01 仍未通过。
