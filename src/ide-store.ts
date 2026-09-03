/** 宿主内存快照：pipe 查询用；JSON 文件只是同内容的调试落盘。 */

export type IdeSnapshotKey =
  | "context"
  | "diagnostics"
  | "workspace"
  | "languageConfig";

const snapshots: Partial<Record<IdeSnapshotKey, unknown>> = {};

export function publishIdeSnapshot(key: IdeSnapshotKey, value: unknown): void {
  snapshots[key] = value;
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
