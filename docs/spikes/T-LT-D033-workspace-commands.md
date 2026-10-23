# T-LT-D033：校验正式 Workspace 命令

实际完成：2026-10-23。Main 在分派正式命令前，检查当前窗口、主 Frame、固定 Renderer 文件 URL，再按命令校验字段、嵌套结构、枚举、数值与长度。未知命令、额外字段、循环或非 JSON 值、无效参数在调用业务前拒绝。协议省略版本时按既有 v1 解释，显式不兼容版本拒绝；没有宣称已实现 Daemon 连接协商或 epoch 校验。

总体 JSON 预算为 4 MiB；原 128 KiB 限制无法容纳合法的 64k 中文 Prompt、512 KiB Memory 或转义后的剪贴板文本。各字段继续受独立限额约束。路径归属、Session 存在性及 Runtime 权限仍由正式服务验证，不把字符串格式校验当成文件系统隔离。

Windows / Node 24.11.1、Electron 43.2.0：桌面编译通过；实际 Main 注册回调的命令合同 5/5 通过，覆盖全部正式命令分支与大内容边界。真实 Electron UI 探测通过设置保存、置顶、拖拽、弹窗和四种尺寸矩阵，固定 Preload 兼容。`npm run check`、`git diff --check` 通过后提交。
