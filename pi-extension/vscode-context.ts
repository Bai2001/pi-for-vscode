// pi-for-vscode 编辑器上下文注入扩展（运行在终端的 pi 进程内）
// 读取 VSCode 扩展写入的 ~/.pi/agent/vscode-ide/<key>/{context.json,workspace.json}，
// 在每次 agent 启动前把当前编辑器上下文 + 工作区结构追加到系统提示词
// （before_agent_start 的 systemPrompt 追加，非替换、非塞进用户消息）。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface EditorContext {
  enabled: boolean;
  /** 属于某根目录时是相对该根的路径；不属于任何根时是绝对路径 */
  activeFile?: string;
  /** 活动文件所属根目录绝对路径 */
  activeFileRoot?: string;
  /** 活动文件所属根目录显示名 */
  activeFileRootName?: string;
  language?: string;
  selection?: string;
  selectionStartLine?: number;
  selectionEndLine?: number;
  cursorLine?: number;
  updatedAt: number;
}

interface WorkspaceFolderInfo {
  name: string;
  path: string;
}

interface WorkspaceInfo {
  updatedAt: number;
  folders: WorkspaceFolderInfo[];
}

// 与 VSCode 扩展一致的编码：cwd 非字母数字转 -，转小写。
// pi 进程 cwd = 终端启动目录 = VSCode 工作区第一个根，同一窗口的 pi 进程共享同一目录。
const IDE_DIR = join(
  homedir(),
  ".pi",
  "agent",
  "vscode-ide",
  process
    .cwd()
    .replace(/[^a-zA-Z0-9]/g, "-")
    .toLowerCase(),
);
const CONTEXT_FILE = join(IDE_DIR, "context.json");
const WORKSPACE_FILE = join(IDE_DIR, "workspace.json");

function readContext(): EditorContext | undefined {
  try {
    const raw = readFileSync(CONTEXT_FILE, "utf8");
    const ctx = JSON.parse(raw) as EditorContext;
    // VSCode 关闭时扩展会写入 enabled:false，这里只需信任文件内容
    // （不做时间过期检查：焦点在 pi 终端时上下文本就不再刷新，但仍是用户需要的）
    if (!ctx.enabled) return undefined;
    return ctx;
  } catch {
    return undefined;
  }
}

function readWorkspace(): WorkspaceInfo | undefined {
  try {
    return JSON.parse(readFileSync(WORKSPACE_FILE, "utf8")) as WorkspaceInfo;
  } catch {
    return undefined;
  }
}

/** 把工作区结构渲染为系统提示词片段。 */
function buildWorkspaceSection(ws: WorkspaceInfo | undefined): string[] {
  if (!ws || ws.folders.length === 0) return [];
  const cwd = process.cwd();
  const lines: string[] = [];
  lines.push("## VSCode 工作区");
  if (ws.folders.length === 1) {
    lines.push(`当前工作区根目录: ${ws.folders[0].path}`);
  } else {
    lines.push(`本窗口是多根工作区，共 ${ws.folders.length} 个根目录:`);
    for (const f of ws.folders) {
      const isCwd = f.path === cwd;
      lines.push(`- ${f.name} → ${f.path}${isCwd ? " ← 当前 cwd" : ""}`);
    }
    lines.push("");
    lines.push("提示：跨根目录操作时，使用上述绝对路径访问其他根下的文件。");
  }
  return lines;
}

function buildInjection(
  ctx: EditorContext | undefined,
  ws: WorkspaceInfo | undefined,
): string | undefined {
  const sections: string[] = [];

  const wsSection = buildWorkspaceSection(ws);
  if (wsSection.length > 0) sections.push(wsSection.join("\n"));

  if (ctx?.activeFile) {
    const lines: string[] = [];
    lines.push("## VSCode 编辑器上下文");
    const fileDesc = ctx.activeFileRoot
      ? `\`${ctx.activeFile}\`（属于根 ${ctx.activeFileRootName ?? ctx.activeFileRoot}，完整路径: ${join(ctx.activeFileRoot, ctx.activeFile)}）`
      : `\`${ctx.activeFile}\`（工作区外文件）`;
    lines.push(
      `当前活动文件: ${fileDesc}${ctx.language ? ` [${ctx.language}]` : ""}`,
    );
    if (ctx.selection !== undefined && ctx.selectionStartLine !== undefined) {
      lines.push(
        `用户选中了第 ${ctx.selectionStartLine}-${ctx.selectionEndLine} 行:`,
      );
      lines.push("```" + (ctx.language ?? ""));
      lines.push(ctx.selection);
      lines.push("```");
    } else if (ctx.cursorLine !== undefined) {
      lines.push(`光标位于第 ${ctx.cursorLine} 行（无选区）。`);
    }
    sections.push(lines.join("\n"));
  }

  if (sections.length === 0) return undefined;
  return sections.join("\n\n");
}

export default function (pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    const ctx = readContext();
    const ws = readWorkspace();
    const injection = buildInjection(ctx, ws);
    if (!injection) return undefined;
    // 追加到现有系统提示词（保留 pi 原有的全部系统提示词）
    return { systemPrompt: `${event.systemPrompt}\n\n${injection}` };
  });
}
