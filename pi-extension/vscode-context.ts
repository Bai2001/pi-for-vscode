// pi-for-vscode 编辑器上下文注入扩展（运行在终端的 pi 进程内）
// 读取 VSCode 扩展写入的 ~/.pi/agent/vscode-context.json，在每次 agent 启动前
// 把当前编辑器上下文追加到系统提示词（before_agent_start 的 systemPrompt 追加，非替换、非塞进用户消息）。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface EditorContext {
  enabled: boolean;
  activeFile?: string;
  language?: string;
  selection?: string;
  selectionStartLine?: number;
  selectionEndLine?: number;
  cursorLine?: number;
  updatedAt: number;
}

// 与 VSCode 扩展一致的编码：cwd 非字母数字转 -，转小写。
// pi 进程 cwd = 终端启动目录 = VSCode 工作区根，多工作区窗口天然隔离。
const CONTEXT_FILE = join(
  homedir(),
  ".pi",
  "agent",
  "vscode-ide",
  process.cwd().replace(/[^a-zA-Z0-9]/g, "-").toLowerCase(),
  "context.json",
);

function readContext(): EditorContext | undefined {
  try {
    const raw = readFileSync(CONTEXT_FILE, "utf8");
    const ctx = JSON.parse(raw) as EditorContext;
    // VSCode 关闭时扩展会写入 enabled:false，这里只需信任文件内容
    // （不做时间过期检查：焦点在 pi 终端时上下文本就不再刷新，但仍是用户需要的）
    if (!ctx.enabled) return undefined;
    if (!ctx.activeFile) return undefined;
    return ctx;
  } catch {
    return undefined;
  }
}

function buildInjection(ctx: EditorContext): string {
  const lines: string[] = [];
  lines.push("## VSCode 编辑器上下文");
  lines.push(`当前活动文件: \`${ctx.activeFile}\`${ctx.language ? ` (${ctx.language})` : ""}`);
  if (ctx.selection !== undefined && ctx.selectionStartLine !== undefined) {
    lines.push(`用户选中了第 ${ctx.selectionStartLine}-${ctx.selectionEndLine} 行:`);
    lines.push("```" + (ctx.language ?? ""));
    lines.push(ctx.selection);
    lines.push("```");
  } else if (ctx.cursorLine !== undefined) {
    lines.push(`光标位于第 ${ctx.cursorLine} 行（无选区）。`);
  }
  return lines.join("\n");
}

export default function (pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    const ctx = readContext();
    if (!ctx) return undefined;
    const injection = buildInjection(ctx);
    // 追加到现有系统提示词（保留 pi 原有的全部系统提示词）
    return { systemPrompt: `${event.systemPrompt}\n\n${injection}` };
  });
}
