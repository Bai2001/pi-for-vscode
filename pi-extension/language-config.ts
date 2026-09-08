import { resolve, sep } from "node:path";

export interface LanguageConfigRoot {
  resource: string;
  name: string;
  typescript: { tsdk: string | null };
  basedpyright: {
    typeCheckingMode: string | null;
    interpreterPath: string | null;
    venvPath: string | null;
  };
}

export interface LanguageConfigSnapshot {
  updatedAt: number;
  roots: LanguageConfigRoot[];
}

/** 诊断哪个工作区，就用哪个根的编辑器语言配置（最长匹配）。 */
export function pickLanguageConfigForCwd(
  snapshot: LanguageConfigSnapshot | undefined | null,
  cwd: string,
): LanguageConfigRoot | undefined {
  if (!snapshot?.roots.length) return undefined;
  let best: LanguageConfigRoot | undefined;
  let bestLen = -1;
  for (const root of snapshot.roots) {
    if (!isSameOrInside(cwd, root.resource)) continue;
    const len = resolve(root.resource).length;
    if (len > bestLen) {
      best = root;
      bestLen = len;
    }
  }
  return best;
}

function isSameOrInside(cwd: string, root: string): boolean {
  const left = normalizePath(cwd);
  const right = normalizePath(root);
  if (left === right) return true;
  const prefix = right.endsWith(sep) ? right : right + sep;
  return left.startsWith(prefix);
}

function normalizePath(value: string): string {
  const resolved = resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

// 本文件是共享模块，不是扩展入口；但会被同步到 ~/.pi/agent/extensions/*.ts，
// pi 会把该目录下每个 .ts 当扩展加载，因此必须导出空工厂，否则启动失败。
export default function (): void {}
