# pi for VSCode

在编辑器区分屏打开 pi 终端，并把编辑器上下文（当前文件、选区）注入 pi 系统提示词。个人自用扩展。

## 功能

- 编辑器标题栏 / 命令面板执行 `pi：打开终端会话`，在编辑器区右侧分屏打开 pi 终端
- 自动把活动编辑器的文件路径与选中代码注入 pi 系统提示词
- 桥接 VSCode 集成浏览器：pi 可用 `vscode_browser_open_page` / `read_page` / `screenshot` / `playwright` 操作页面（需用本命令打开终端，VSCode ≥ 1.110）

## 配置

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `pi-for-vscode.context.enabled` | `true` | 把活动编辑器的文件与选区注入 pi 系统提示词 |
| `pi-for-vscode.context.maxLines` | `200` | 注入的选区最大行数（超出截断） |
| `pi-for-vscode.terminal.splitRight` | `true` | 在编辑器区右侧分屏打开终端（`false` 则使用默认终端位置） |
