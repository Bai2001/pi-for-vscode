# pi for VSCode

在辅助侧栏管理 pi 会话，于编辑器区打开原生终端，并把编辑器上下文（当前文件、选区）注入 pi。个人自用扩展。

## 功能

- 编辑器标题栏 / 命令面板执行 `pi：打开会话`：打开辅助侧栏会话列表，并恢复本工作区上次打开的会话
- 侧栏按今天 / 昨天 / 近 7 天 / 近 30 天 / 更早 / 归档列出当前工作区会话；点击切换或用 `pi --session` 恢复
- 右侧锁定一个原生 Terminal Editor，切会话时换背后的进程，不新开标签；关掉终端默认不杀 pi，可再点列表重建画面
- 支持新建、归档、删除、分叉、回退；列表显示 working / idle 状态
- 自动把工作区写入系统提示词；活动文件与选区仅在变化时作为对话消息注入
- 桥接 VSCode 集成浏览器：pi 可用 `vscode_browser_open_page` / `read_page` / `screenshot` / `playwright` 操作页面（需用本扩展打开会话，VSCode ≥ 1.110）
- 编辑器上下文、诊断与浏览器均走 named pipe；`~/.pi/agent/vscode-ide/` 下 JSON 仅供调试查看

## 配置

| 配置项                                    | 默认值     | 说明                                                         |
| ----------------------------------------- | ---------- | ------------------------------------------------------------ |
| `pi-for-vscode.context.enabled`           | `true`     | 把活动编辑器的文件与选区在变化时注入 pi 对话                 |
| `pi-for-vscode.context.maxLines`          | `200`      | 注入的选区最大行数（超出截断）                               |
| `pi-for-vscode.command`                   | `pi`       | pi 可执行文件名或绝对路径；保持 `pi` 则自动探测              |
| `pi-for-vscode.terminal.closeBehavior`    | `detach`   | `detach`：关终端进程仍在；`stop`：关终端同时结束 pi          |
