// 浏览器/IDE named pipe 身份：由工作区路径决定，reload 后不变，旧 pi 进程仍能连上。
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface IpcEndpoint {
  id: string;
  token: string;
}

export function pipePath(id: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\pi-for-vscode-browser-${id}`;
  }
  return join(tmpdir(), `pi-for-vscode-browser-${id}.sock`);
}

/** 同一工作区永远得到同一 id/token；无文件夹时用固定占位。 */
export function ipcIdentityForWorkspace(folder: string | undefined): IpcEndpoint {
  const key = (folder ?? "no-workspace").replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
  const id = createHash("sha256").update(`pipe:${key}`).digest("hex").slice(0, 16);
  const token = createHash("sha256").update(`token:${key}`).digest("base64url");
  return { id, token };
}
