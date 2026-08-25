# AGENTS.md

pi for VSCode —— 在编辑器区分屏打开 pi 终端并注入编辑器上下文的个人自用扩展。

## 项目结构

- `src/extension.ts`：VSCode 扩展主入口（ esbuild 打包到 `dist/`）
- `pi-extension/`：pi 侧扩展（运行时在终端 pi 进程内由 jiti 直接加载，**无需构建**）：
  - `run-diagnostics.ts`：`run_diagnostics` CLI 诊断工具（vue-tsc / tsc / basedpyright + ruff）
  - `vscode-context.ts`、`vscode-diagnostics.ts`：编辑器上下文 / 诊断桥接
- `pi-extension/tsconfig.json`：仅供编辑器类型检查；`paths` 内 SDK 路径带版本哈希，pi 大版本升级后需同步更新

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
