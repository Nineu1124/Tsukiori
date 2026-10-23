# T-LT-D032：统一正式事件转换

实际完成：2026-10-23。Codex 原生通知由独立转换器产生有序投影，正式工作区按原顺序执行状态、审批、团队与保存操作。Claude/Codex 错误走统一脱敏入口；Direct API 已分类的错误保留原类别。

统一事件工厂生成外层 schemaVersion 1、宿主序号与身份。旧 Transcript 未带版本的记录可读取，已有事件 ID、创建时间及完整模型消息保持；未知未来版本、跨会话记录拒绝恢复，继续使用不完整历史提示。Thinking、工具、子代理和压缩事件的原生关联字段及 payload 版本不变。

Windows / Node 24.11.1：桌面编译通过；事件合同、正式 InteractiveWorkspace 和历史重启回归共 33/33。包括实际离线 Codex/Claude/API 调用链、审批、Fork、Checkpoint、Team、长于旧缓存限制的模型历史与脱敏。`npm run check`、`git diff --check` 通过后提交。真实 Runtime 能力仍按原验收等级记录。
