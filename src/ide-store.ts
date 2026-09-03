/** 宿主内存快照：pipe 查询用；JSON 文件只是同内容的调试落盘。 */

export type IdeSnapshotKey =
  | "context"
  | "diagnostics"
  | "workspace"
  | "languageConfig";

export type IdeSnapshotListener = (key: IdeSnapshotKey, value: unknown) => void;

const snapshots: Partial<Record<IdeSnapshotKey, unknown>> = {};
const lastFingerprint: Partial<Record<IdeSnapshotKey, string>> = {};
const listeners = new Set<IdeSnapshotListener>();

/** 去掉 updatedAt 后比较，避免无内容变化的时间戳刷订阅者。 */
export function snapshotFingerprint(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return JSON.stringify(value ?? null);
  }
  const { updatedAt: _ignore, ...rest } = value as Record<string, unknown>;
  return JSON.stringify(rest);
}

export function onIdeSnapshot(listener: IdeSnapshotListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishIdeSnapshot(key: IdeSnapshotKey, value: unknown): void {
  snapshots[key] = value;
  const fp = snapshotFingerprint(value);
  if (fp === lastFingerprint[key]) return;
  lastFingerprint[key] = fp;
  for (const listener of listeners) listener(key, value);
}

export function getIdeSnapshot(key: IdeSnapshotKey): unknown {
  return snapshots[key] ?? null;
}

export function ideKeyFromMethod(method: string): IdeSnapshotKey | undefined {
  switch (method) {
    case "get_context":
      return "context";
    case "get_diagnostics":
      return "diagnostics";
    case "get_workspace":
      return "workspace";
    case "get_language_config":
      return "languageConfig";
    default:
      return undefined;
  }
}
