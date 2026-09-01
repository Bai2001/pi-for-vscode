// pi-for-vscode 编辑器上下文注入扩展（运行在终端的 pi 进程内）
// 读取 VSCode 扩展写入的 ~/.pi/agent/vscode-ide/<key>/{context.json,workspace.json}，
// 1. 在每次 agent 启动前把当前编辑器上下文 + 工作区结构追加到系统提示词
//    （before_agent_start 的 systemPrompt 追加，非替换、非塞进用户消息）；
// 2. 在输入框上边框右侧幽灵显示工作区根名 + 当前活动文件（给编辑器 render 打补丁）。
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CustomEditor, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";

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
    lines.push(`当前活动文件: ${fileDesc}${ctx.language ? ` [${ctx.language}]` : ""}`);
    if (ctx.selection !== undefined && ctx.selectionStartLine !== undefined) {
      lines.push(`用户选中了第 ${ctx.selectionStartLine}-${ctx.selectionEndLine} 行:`);
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
const HINT_MAX_WIDTH = 40; // 标签最大可见宽度（还会按编辑器实际列宽再收）
const HINT_MIN_BORDER = 16; // 上边框至少保留的 ─ 列数，避免盒子看起来残缺
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

// SGR 序列匹配（用 new RegExp 构造，避免正则字面量中的控制字符告警）
const ESC = String.fromCharCode(27);
const SGR_RE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const SGR_AT_START_RE = new RegExp(`^${ESC}\\[[0-9;]*m`);
const SGR_PREFIX_RE = new RegExp(`^(?:${ESC}\\[[0-9;]*m)+`);

function visualWidth(s: string): number {
  const plain = s.replace(SGR_RE, "");
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
    if (s[i] === ESC) {
      const m = SGR_AT_START_RE.exec(s.slice(i));
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

interface HintParts {
  root: string;
  file: string;
}

interface HintCache {
  wsMtime: number;
  ctxMtime: number;
  parts?: HintParts;
}

let hintCache: HintCache = { wsMtime: -1, ctxMtime: -1 };

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return -1;
  }
}

function computeHintParts(): HintParts | undefined {
  const ws = readWorkspace();
  if (!ws || ws.folders.length === 0) return undefined;
  // Windows 路径大小写不敏感，统一小写比较（同 buildWorkspaceSection）
  const cwdLower = process.cwd().toLowerCase();
  const cwdFolder = ws.folders.find((f) => f.path.toLowerCase() === cwdLower) ?? ws.folders[0];

  let root = cwdFolder.name;
  let file = "";
  const editorCtx = readContext();
  if (editorCtx?.activeFile) {
    // 多根工作区显示文件所属根，而不是 cwd+N（后者既占宽度又看不出文件在哪）
    root = editorCtx.activeFileRootName ?? cwdFolder.name;
    file = editorCtx.activeFile;
    if (editorCtx.selectionStartLine !== undefined && editorCtx.selectionEndLine !== undefined) {
      file +=
        editorCtx.selectionStartLine === editorCtx.selectionEndLine
          ? `:${editorCtx.selectionStartLine}`
          : `:${editorCtx.selectionStartLine}-${editorCtx.selectionEndLine}`;
    } else if (editorCtx.cursorLine !== undefined) {
      file += `:${editorCtx.cursorLine}`;
    }
  }
  return { root, file };
}

/** 纯文本从左侧截断到指定可见宽度（保留尾部） */
function truncateLeftPlain(s: string, maxWidth: number): string {
  let out = "";
  let w = 0;
  const chars = [...s];
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = charWidth(chars[i]!.codePointAt(0)!);
    if (w + cw > maxWidth) break;
    out = chars[i] + out;
    w += cw;
  }
  return out;
}

/** 路径过长时丢掉左侧目录分量，尽量完整保留文件名和行号 */
function truncatePathTail(s: string, maxWidth: number): string {
  if (visualWidth(s) <= maxWidth) return s;
  const sep = s.includes("\\") ? "\\" : "/";
  const parts = s.split(/[/\\]/);
  const used: string[] = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    const trial = [parts[i], ...used].join(sep);
    const label = i > 0 ? `...${sep}${trial}` : trial;
    if (visualWidth(label) > maxWidth) break;
    used.unshift(parts[i]!);
  }
  if (used.length === 0) {
    const base = parts[parts.length - 1] ?? s;
    if (visualWidth(base) <= maxWidth) return base;
    return truncateLeftPlain(base, maxWidth);
  }
  const joined = used.join(sep);
  if (used.length < parts.length) {
    const dotted = `...${sep}${joined}`;
    if (visualWidth(dotted) <= maxWidth) return dotted;
  }
  return joined;
}

function formatHintLabel(parts: HintParts, maxWidth: number): string {
  if (!parts.file) {
    return visualWidth(parts.root) <= maxWidth
      ? parts.root
      : `${truncateVisual(parts.root, Math.max(1, maxWidth - 3))}...`;
  }
  const sep = " / ";
  const full = `${parts.root}${sep}${parts.file}`;
  if (visualWidth(full) <= maxWidth) return full;
  const fileBudget = maxWidth - visualWidth(parts.root) - visualWidth(sep);
  if (fileBudget >= 8) return `${parts.root}${sep}${truncatePathTail(parts.file, fileBudget)}`;
  return `${truncateVisual(full, Math.max(1, maxWidth - 3))}...`;
}

/** 按文件 mtime 缓存原始片段，截断在 render 时按实际列宽做 */
function getHintParts(): HintParts | undefined {
  const wsMtime = mtimeOf(WORKSPACE_FILE);
  const ctxMtime = mtimeOf(CONTEXT_FILE);
  if (wsMtime !== hintCache.wsMtime || ctxMtime !== hintCache.ctxMtime) {
    hintCache = { wsMtime, ctxMtime, parts: computeHintParts() };
  }
  return hintCache.parts;
}

type EditorLike = { render(width: number): string[] };

const patchedEditors = new WeakSet<object>();

/** 取字符串去掉 SGR 序列后的最后一个可见字符（圆角边框的 ╮ / 直边框的 ─） */
function lastVisibleChar(s: string): string {
  const plain = s.replace(SGR_RE, "");
  return [...plain].at(-1) ?? "";
}

/**
 * 给编辑器实例的 render 打补丁：首行（上边框）右侧叠加暗色标签。
 * 不替换编辑器实例，避免破坏 pi-open-tui 等扩展的自定义编辑器；
 * 输入行为完全不变，标签纯展示。
 */
function patchEditorRender<T extends EditorLike>(editor: T, getTheme: () => Theme | undefined): T {
  if (patchedEditors.has(editor)) return editor;
  patchedEditors.add(editor);
  const origRender = editor.render.bind(editor);
  editor.render = (width: number): string[] => {
    const lines = origRender(width);
    if (lines.length === 0 || width < HINT_MIN_WIDTH) return lines;
    const parts = getHintParts();
    const theme = getTheme();
    if (!parts || !theme) return lines;
    const maxLabel = Math.min(HINT_MAX_WIDTH, Math.max(8, width - HINT_MIN_BORDER));
    const label = formatHintLabel(parts, maxLabel);
    const text = ` ${label} `;
    const labelWidth = visualWidth(text);
    // 标签 + 右侧框角之外，至少保留 HINT_MIN_BORDER 列边框
    if (labelWidth > width - HINT_MIN_BORDER) return lines;
    const line = lines[0]!;
    // 截掉右侧一段边框，插入标签，再补上带原边框色的行尾字符（╮/─），
    // 使框角颜色与主题一致
    const borderPrefix = SGR_PREFIX_RE.exec(line)?.[0] ?? "";
    const patched =
      truncateVisual(line, width - labelWidth - 1) +
      theme.fg("dim", text) +
      borderPrefix +
      lastVisibleChar(line);
    // 宁可丢掉标签，也不让这一行超出 width：pi-tui 会因换行错位把整页画残
    if (visualWidth(patched) > width) return lines;
    lines[0] = patched;
    return lines;
  };
  return editor;
}

interface HintState {
  /** 检查当前生效的编辑器工厂是否仍是我们的包装，被其他扩展替换则重新包装。返回是否刚重新包装。 */
  ensure: () => boolean;
  requestRender: () => void;
}

function registerWorkspaceHint(pi: ExtensionAPI): void {
  let hintState: HintState | undefined;
  let hintTimer: ReturnType<typeof setInterval> | undefined;
  const delayTimers: ReturnType<typeof setTimeout>[] = [];

  const stopHintTimer = () => {
    if (hintTimer !== undefined) {
      clearInterval(hintTimer);
      hintTimer = undefined;
    }
    for (const t of delayTimers) clearTimeout(t);
    delayTimers.length = 0;
    hintState = undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    let tuiRef: { requestRender(): void } | undefined;
    // 当前被包装的工厂（pi-open-tui 的圆角编辑器工厂，或 undefined 用默认编辑器兜底）
    let innerFactory: ReturnType<typeof ctx.ui.getEditorComponent>;
    const wrapperFactory: NonNullable<Parameters<typeof ctx.ui.setEditorComponent>[0]> = (
      tui,
      theme,
      keybindings,
    ) => {
      tuiRef = tui;
      const editor = innerFactory
        ? innerFactory(tui, theme, keybindings)
        : new CustomEditor(tui, theme, keybindings);
      return patchEditorRender(editor, () => {
        try {
          return ctx.ui.theme;
        } catch {
          // 会话已替换时 TUI 仍可能重绘；跳过标签，避免 render 打崩进程
          return undefined;
        }
      });
    };
    // 扩展是异步逐个加载的，pi-open-tui 可能在我们之后才注册它的工厂，
    // 一次性延迟注册不可靠；由定时器持续检查，被替换后重新包装
    const ensureWrapped = (): boolean => {
      try {
        const current = ctx.ui.getEditorComponent();
        if (current === wrapperFactory) return false;
        innerFactory = current;
        ctx.ui.setEditorComponent(wrapperFactory);
        return true;
      } catch {
        stopHintTimer();
        return false;
      }
    };
    ensureWrapped();
    hintState = {
      ensure: ensureWrapped,
      requestRender: () => tuiRef?.requestRender(),
    };
    // 分屏落位 / pi-open-tui 晚于我们注册工厂时，首帧可能是错列宽或未包装的编辑器。
    // 延迟再画几次，避免必须手动拖动终端大小才恢复。
    for (const ms of [0, 200, 500]) {
      const t = setTimeout(() => hintState?.requestRender(), ms);
      t.unref?.();
      delayTimers.push(t);
    }
    // 1. 编辑器工厂被其他扩展替换后重新包装并重绘；2. VSCode 侧更新 json 后主动重绘
    if (hintTimer === undefined) {
      hintTimer = setInterval(() => {
        try {
          const rewrapped = hintState?.ensure() ?? false;
          const before = hintCache.parts;
          getHintParts();
          if (rewrapped || hintCache.parts !== before) hintState?.requestRender();
        } catch {
          // /reload、/new 等会让旧 ctx 失效；漏清理时也不能让 uncaughtException 打崩进程
          stopHintTimer();
        }
      }, HINT_REFRESH_MS);
      hintTimer.unref?.();
    }
  });

  // 定时器闭包了 session_start 的 ctx；/reload、/new、/resume、/fork 会 invalidate 旧 ctx
  pi.on("session_shutdown", () => {
    stopHintTimer();
  });
}
