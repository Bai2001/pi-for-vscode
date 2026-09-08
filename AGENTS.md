# AGENTS.md

pi for VSCode —— 在编辑器区分屏打开 pi 终端并注入编辑器上下文的个人自用扩展。

## 项目结构

- `src/`：VSCode 扩展宿主（Vite 打成 `dist/extension.cjs`，`src/` 不进 vsix）
  - `extension.ts`：激活入口；`update.ts` / `sync-pi-extension.ts` 为宿主级辅助
  - `session/`：侧栏会话列表、存储/操作、状态桥、Terminal Editor 编排
  - `terminal/`：node-pty 伪终端、conpty 滚轮、回放、Windows 启动命令
  - `ide/`：编辑器快照与浏览器 named pipe IPC
  - 测试与源码同目录（`*.test.ts`，`npm test` / Vitest 扫 `src/**/*.test.ts`）
- `pi-extension/`：pi 侧扩展（运行时在终端 pi 进程内由 jiti 直接加载，**无需构建**）：
  - `run-diagnostics.ts`：`run_diagnostics` CLI 诊断工具（vue-tsc / tsc / basedpyright + ruff）
  - `vscode-browser.ts`：VSCode 内置浏览器工具
  - `vscode-context.ts`：工作区写入系统提示词；活动文件/选区变化时注入对话消息；输入框上方 widget 显示「工作区根名 / 当前活动文件」
  - `vscode-diagnostics.ts`：诊断桥接
  - `vscode-ipc.ts`：named pipe 共享客户端（会被同步到 `~/.pi/agent/extensions/`，必须导出空工厂，否则 pi 会当扩展加载并启动失败）
- `pi-extension/tsconfig.json`：仅供编辑器类型检查；`paths` 内 SDK 路径带版本哈希，pi 大版本升级后需同步更新
- `media/`：侧栏 webview（`main.css` / `main.js` / `session-view.js`）与图标
- `resources/pi-vscode-status.ts`：注入 pi 进程的状态上报脚本（需打进 vsix，因此不放 `src/`）
- `dist/`：构建产物（gitignore）
- `.github/workflows/release.yml`：推送 `v*` tag 后打包并发布 VSIX
- `docs/`：早期 GUI 方案草稿（React 面板），与当前「原生终端 + 会话列表」实现不一致，**不要按该文档改代码**

## 发布新版本

推送 `v*` tag 触发 `.github/workflows/release.yml`：校验 tag 与 package.json 版本一致 → `npm ci` → 打包 VSIX → 发布 GitHub Release（Release notes 自动生成）。

完整步骤：

1. 完成功能/修复并按中文 Conventional Commits 提交（type 英文小写，scope/description 中文）
2. 同步修改三处版本号（保持一致）：
   - `package.json` 的 `version`
   - `package-lock.json` 第 3 行根 `version`
   - `package-lock.json` 中 `packages[""]` 的 `version`
3. 提交 `chore(release): x.y.z`
4. 打 tag 并推送：

   ```bash
   git tag vx.y.z
   git push origin main
   git push origin vx.y.z
   ```

注意：

- tag 版本必须与 package.json 完全一致，否则 workflow 校验失败
- `devEngines` 要求 npm 12.0.2；本地 Node 24 自带 npm 11 会因校验失败无法执行命令，CI 中已在仓库目录外升级 npm
- CI 使用 npmmirror 镜像源（与 lockfile 的 resolved 地址一致）

## 常用命令

```bash
npm run package   # 打包 VSIX
```
