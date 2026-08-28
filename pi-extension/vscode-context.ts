// pi-for-vscode 编辑器上下文注入扩展（运行在终端的 pi 进程内）
// 读取 VSCode 扩展写入的 ~/.pi/agent/vscode-ide/<key>/{context.json,workspace.json}，
// 1. 在每次 agent 启动前把当前编辑器上下文 + 工作区结构追加到系统提示词
//    （before_agent_start 的 systemPrompt 追加，非替换、非塞进用户消息）；
// 2. 在输入框上边框右侧幽灵显示工作区根名 + 当前活动文件（WorkspaceHintEditor）。
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CustomEditor,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";

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
  // Windows 路径大小写不敏感（VSCode 写小写 c:\，process.cwd() 是大写 C:\），统一转小写比较
  const cwdLower = process.cwd().toLowerCase();
  const lines: string[] = [];
  lines.push("## VSCode 工作区");
  if (ws.folders.length === 1) {
    lines.push(`当前工作区根目录: ${ws.folders[0].path}`);
  } else {
    lines.push(`本窗口是多根工作区，共 ${ws.folders.length} 个根目录:`);
    for (const f of ws.folders) {
      const isCwd = f.path.toLowerCase() === cwdLower;
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

  registerWorkspaceHint(pi);
}

// ===== 输入框上边框右侧的幽灵显示：工作区根名 + 当前活动文件 =====
// 纯展示（不参与输入），数据与系统提示词注入同源（vscode-ide/*.json），
// 随 VSCode 侧写入自动更新。

const HINT_MIN_WIDTH = 40; // 终端列宽窄于此值不显示
const HINT_MAX_WIDTH = 48; // 标签最大可见宽度
const HINT_REFRESH_MS = 1500; // 轮询 json 文件变化的间隔

// 本地实现可见宽度 / 截断，避免运行时依赖 pi-tui 的工具函数
// （边框行只有 SGR 序列，文件夹名可能含 CJK 宽字符）

function charWidth(cp: number): number {
  return cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
    ? 2
    : 1;
}

function visualWidth(s: string): number {
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of plain) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/** 按可见宽度截断，保留 SGR 序列（TUI 每行末尾会自动补 reset） */
function truncateVisual(s: string, maxWidth: number): string {
  let out = "";
  let w = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const cp = s.codePointAt(i)!;
    const cw = charWidth(cp);
    if (w + cw > maxWidth) break;
    out += String.fromCodePoint(cp);
    w += cw;
    i += cp > 0xffff ? 2 : 1;
  }
  return out;
}

interface HintCache {
  wsMtime: number;
  ctxMtime: number;
  label?: string;
}

let hintCache: HintCache = { wsMtime: -1, ctxMtime: -1 };

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return -1;
  }
}

function computeHintLabel(): string | undefined {
  const ws = readWorkspace();
  if (!ws || ws.folders.length === 0) return undefined;
  // Windows 路径大小写不敏感，统一小写比较（同 buildWorkspaceSection）
  const cwdLower = process.cwd().toLowerCase();
  const cwdFolder = ws.folders.find((f) => f.path.toLowerCase() === cwdLower) ?? ws.folders[0];
  let label = cwdFolder.name;
  if (ws.folders.length > 1) label += `+${ws.folders.length - 1}`;
  const editorCtx = readContext();
  if (editorCtx?.activeFile) label += ` · ${editorCtx.activeFile}`;
  if (visualWidth(label) > HINT_MAX_WIDTH) {
    label = `${truncateVisual(label, HINT_MAX_WIDTH - 1)}…`;
  }
  return label;
}

/** 按文件 mtime 缓存，避免每次渲染都读盘解析 */
function getHintLabel(): string | undefined {
  const wsMtime = mtimeOf(WORKSPACE_FILE);
  const ctxMtime = mtimeOf(CONTEXT_FILE);
  if (wsMtime !== hintCache.wsMtime || ctxMtime !== hintCache.ctxMtime) {
    hintCache = { wsMtime, ctxMtime, label: computeHintLabel() };
  }
  return hintCache.label;
}

type EditorCtorArgs = ConstructorParameters<typeof CustomEditor>;

/** 包装默认编辑器：仅在上边框行右侧叠加暗色标签，输入行为完全不变 */
class WorkspaceHintEditor extends CustomEditor {
  private readonly getTheme: () => Theme;

  constructor(
    tui: EditorCtorArgs[0],
    theme: EditorCtorArgs[1],
    keybindings: EditorCtorArgs[2],
    getTheme: () => Theme,
  ) {
    super(tui, theme, keybindings);
    this.getTheme = getTheme;
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length === 0 || width < HINT_MIN_WIDTH) return lines;
    const label = getHintLabel();
    if (!label) return lines;
    const text = ` ${label} `;
    const labelWidth = visualWidth(text);
    // 右侧至少留 2 列边框，放不下就不显示
    if (labelWidth > width - 4) return lines;
    lines[0] = truncateVisual(lines[0]!, width - labelWidth) + this.getTheme().fg("dim", text);
    return lines;
  }
}

function registerWorkspaceHint(pi: ExtensionAPI): void {
  let hintTimerStarted = false;
  pi.on("session_start", (_event, ctx) => {
    let tuiRef: { requestRender(): void } | undefined;
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      tuiRef = tui;
      return new WorkspaceHintEditor(tui, theme, keybindings, () => ctx.ui.theme);
    });
    // pi 空闲时 VSCode 侧仍会更新 json，轮询 mtime 变化后主动触发重绘
    // （Editor.render 每次重算，invalidate 是 no-op，无需额外失效）
    if (!hintTimerStarted) {
      hintTimerStarted = true;
      const timer = setInterval(() => {
        const before = hintCache.label;
        if (getHintLabel() !== before) tuiRef?.requestRender();
      }, HINT_REFRESH_MS);
      timer.unref?.();
    }
  });
}
