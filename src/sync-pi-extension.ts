// pi 端扩展文件自动同步
// 职责：扩展激活时，把内置的 pi-extension/*.ts 拷贝到 ~/.pi/agent/extensions/，
// 保证 pi 进程加载的扩展代码与 VSCode 扩展版本一致（版本升级时自动覆盖旧版）。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";

/** pi 扩展加载目录（pi 进程从这里读 .ts 文件） */
function piExtensionsDir(): string {
  return path.join(os.homedir(), ".pi", "agent", "extensions");
}

/** 同步到 ~/.pi/agent/extensions 的源文件：入口/共享模块，不含测试。 */
export function isPiExtensionSourceFile(name: string): boolean {
  return name.endsWith(".ts") && !name.endsWith(".test.ts");
}

/**
 * 把扩展内置的 pi-extension/*.ts 同步到 ~/.pi/agent/extensions/。
 * 策略：直接全量覆盖（用户的改动应该在项目源码里改，而不是在同步目标里改）。
 * 异步执行，不阻塞激活；失败仅记录日志 + 一次性通知。
 */
export async function syncPiExtensions(context: vscode.ExtensionContext): Promise<void> {
  const srcDir = path.join(context.extensionPath, "pi-extension");
  const destDir = piExtensionsDir();

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(srcDir, { withFileTypes: true });
  } catch (err) {
    console.error("[pi-for-vscode] 读取内置 pi-extension 目录失败:", err);
    return;
  }

  const tsFiles = entries
    .filter((e) => e.isFile() && isPiExtensionSourceFile(e.name))
    .map((e) => e.name);
  if (tsFiles.length === 0) return;

  try {
    await fs.promises.mkdir(destDir, { recursive: true });
  } catch (err) {
    console.error("[pi-for-vscode] 创建 pi 扩展目录失败:", err);
    return;
  }

  const updated: string[] = [];
  const failed: Array<{ name: string; err: unknown }> = [];

  for (const name of tsFiles) {
    const src = path.join(srcDir, name);
    const dest = path.join(destDir, name);
    try {
      const content = await fs.promises.readFile(src, "utf8");
      // 内容一致则跳过，避免无谓 IO
      let existing: string | undefined;
      try {
        existing = await fs.promises.readFile(dest, "utf8");
      } catch {
        existing = undefined;
      }
      if (existing === content) continue;
      await fs.promises.writeFile(dest, content, "utf8");
      updated.push(name);
    } catch (err) {
      failed.push({ name, err });
    }
  }

  if (updated.length > 0) {
    console.log(`[pi-for-vscode] 已同步 ${updated.length} 个 pi 扩展文件:`, updated.join(", "));
  }
  if (failed.length > 0) {
    console.error("[pi-for-vscode] 部分 pi 扩展文件同步失败:", failed);
    // 一次性提示，避免每次激活都弹
    void (await import("vscode")).window.showWarningMessage(
      `pi-for-vscode: 无法同步 pi 扩展文件（${failed.map((f) => f.name).join(", ")}），请检查文件占用或权限。`,
    );
  }
}
