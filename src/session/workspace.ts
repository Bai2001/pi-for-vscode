import { resolve } from "node:path";

export interface WorkspaceRoot {
  name: string;
  path: string;
}

export function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** 首选路径仍在工作区根列表里则用之，否则退回第一个根。 */
export function coerceWorkspaceCwd(
  folders: readonly WorkspaceRoot[],
  preferred?: string,
): string | undefined {
  if (folders.length === 0) return undefined;
  if (preferred) {
    const hit = folders.find((folder) => samePath(folder.path, preferred));
    if (hit) return hit.path;
  }
  return folders[0]?.path;
}

/** 多根时返回会话所属根名；单根不显示。 */
export function rootNameForCwd(folders: readonly WorkspaceRoot[], cwd: string): string | undefined {
  if (folders.length <= 1) return undefined;
  return folders.find((folder) => samePath(folder.path, cwd))?.name;
}
