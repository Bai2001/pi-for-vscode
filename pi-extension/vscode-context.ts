// pi-for-vscode 编辑器上下文注入扩展（运行在终端的 pi 进程内）
// 经 named pipe 向 VSCode 宿主查询/订阅上下文与工作区（JSON 文件仅宿主调试落盘，此处不读）。
// 1. 工作区结构追加到系统提示词（稳定环境，每轮覆盖同一段）；
// 2. 活动文件/选区作为 custom 消息插在本轮用户消息后，仅在变化或压缩丢失时插入；
// 3. 输入框上边框右侧幽灵显示工作区根名 + 当前活动文件（给编辑器 render 打补丁）。
import { join } from "node:path";
import { CustomEditor, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { callIpcData, hasIpc, subscribeIde, type IdeSubscribeData } from "./vscode-ipc";

const EDITOR_CONTEXT_CUSTOM_TYPE = "vscode-editor-context";

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

interface EditorContextDetails {
  fingerprint: string;
  summary: string;
}

interface ContextEntryLike {
  type?: string;
  customType?: string;
  details?: unknown;
}

function editorContextFingerprint(ctx: EditorContext | undefined): string | undefined {
  if (!ctx?.enabled || !ctx.activeFile) return undefined;
  return JSON.stringify({
    activeFile: ctx.activeFile,
    activeFileRoot: ctx.activeFileRoot,
    language: ctx.language,
    selection: ctx.selection,
    selectionStartLine: ctx.selectionStartLine,
    selectionEndLine: ctx.selectionEndLine,
    cursorLine: ctx.cursorLine,
  });
}

function shouldInjectEditorContext(
  currentFingerprint: string | undefined,
  lastFingerprint: string | undefined,
): boolean {
  if (!currentFingerprint) return false;
  return currentFingerprint !== lastFingerprint;
}

function lastInjectedFingerprint(entries: readonly ContextEntryLike[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type !== "custom_message" || entry.customType !== EDITOR_CONTEXT_CUSTOM_TYPE) {
      continue;
    }
    const fp = (entry.details as EditorContextDetails | undefined)?.fingerprint;
    return typeof fp === "string" ? fp : undefined;
  }
  return undefined;
}

function buildWorkspaceSystemPrompt(
  ws: WorkspaceInfo | undefined,
  cwd: string,
): string | undefined {
  if (!ws || ws.folders.length === 0) return undefined;
  const cwdLower = cwd.toLowerCase();
  const lines: string[] = ["## VSCode 工作区"];
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
  return lines.join("\n");
}

function describeActiveFile(ctx: EditorContext): string {
  if (!ctx.activeFile) return "";
  if (ctx.activeFileRoot) {
    const full = join(ctx.activeFileRoot, ctx.activeFile);
    return `\`${ctx.activeFile}\`（属于根 ${ctx.activeFileRootName ?? ctx.activeFileRoot}，完整路径: ${full}）`;
  }
  return `\`${ctx.activeFile}\`（工作区外文件）`;
}

function buildEditorContextContent(ctx: EditorContext | undefined): string | undefined {
  if (!ctx?.activeFile) return undefined;
  const lines: string[] = ["## VSCode 编辑器上下文"];
  lines.push(`当前活动文件: ${describeActiveFile(ctx)}${ctx.language ? ` [${ctx.language}]` : ""}`);
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

function buildEditorContextSummary(ctx: EditorContext | undefined): string | undefined {
  if (!ctx?.activeFile) return undefined;
  if (ctx.selectionStartLine !== undefined && ctx.selectionEndLine !== undefined) {
    const range =
      ctx.selectionStartLine === ctx.selectionEndLine
        ? `${ctx.selectionStartLine}`
        : `${ctx.selectionStartLine}-${ctx.selectionEndLine}`;
    return `VSCode 选中 ${ctx.activeFile}:${range}`;
  }
  if (ctx.cursorLine !== undefined) {
    return `VSCode 活动文件 ${ctx.activeFile}:${ctx.cursorLine}`;
  }
  return `VSCode 活动文件 ${ctx.activeFile}`;
}

let haveLiveContext = false;
let haveLiveWorkspace = false;
let liveContext: EditorContext | undefined;
let liveWorkspace: WorkspaceInfo | undefined;

function parseEditorContext(raw: unknown): EditorContext | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const ctx = raw as EditorContext;
  if (!ctx.enabled) return undefined;
  return ctx;
}

function parseWorkspace(raw: unknown): WorkspaceInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const ws = raw as WorkspaceInfo;
  if (!Array.isArray(ws.folders)) return undefined;
  return ws;
}

async function fetchContext(): Promise<EditorContext | undefined> {
  if (haveLiveContext) return liveContext;
  if (!hasIpc()) return undefined;
  try {
    const ctx = await callIpcData<EditorContext>("get_context");
    if (!ctx?.enabled) return undefined;
    return ctx;
  } catch {
    return undefined;
  }
}

async function fetchWorkspace(): Promise<WorkspaceInfo | undefined> {
  if (haveLiveWorkspace) return liveWorkspace;
  if (!hasIpc()) return undefined;
  try {
    const ws = await callIpcData<WorkspaceInfo>("get_workspace");
    if (!ws || !Array.isArray(ws.folders)) return undefined;
    return ws;
  } catch {
    return undefined;
  }
}

export default function (pi: ExtensionAPI): void {
  startIdeSubscription();
  registerEditorContextRenderer(pi);

  pi.on("before_agent_start", async (event, session) => {
    const [editor, ws] = await Promise.all([fetchContext(), fetchWorkspace()]);
    const workspacePrompt = buildWorkspaceSystemPrompt(ws, process.cwd());
    const content = buildEditorContextContent(editor);
    const summary = buildEditorContextSummary(editor);
    const fingerprint = editorContextFingerprint(editor);
    const lastFp = lastInjectedFingerprint(session.sessionManager.buildContextEntries());
    const injectEditor =
      content !== undefined &&
      summary !== undefined &&
      fingerprint !== undefined &&
      shouldInjectEditorContext(fingerprint, lastFp);

    if (!workspacePrompt && !injectEditor) return undefined;
    return {
      ...(workspacePrompt ? { systemPrompt: `${event.systemPrompt}\n\n${workspacePrompt}` } : {}),
      ...(injectEditor
        ? {
            message: {
              customType: EDITOR_CONTEXT_CUSTOM_TYPE,
              content,
              display: true,
              details: { fingerprint, summary } satisfies EditorContextDetails,
            },
          }
        : {}),
    };
  });

  registerWorkspaceHint(pi);
}

function registerEditorContextRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(EDITOR_CONTEXT_CUSTOM_TYPE, (message, _options, theme) => {
    const details = message.details as EditorContextDetails | undefined;
    const summary =
      details?.summary ??
      (typeof message.content === "string" ? message.content.split("\n")[0] : undefined) ??
      "VSCode 编辑器上下文";
    return {
      render: () => [theme.fg("dim", summary)],
      invalidate() {},
    };
  });
}

// ===== 输入框上边框右侧的幽灵显示：工作区根名 + 当前活动文件 =====
// 纯展示（不参与输入），数据与注入同源（subscribe_ide 推送）。

const HINT_MIN_WIDTH = 40; // 终端列宽窄于此值不显示
const HINT_MAX_WIDTH = 40; // 标签最大可见宽度（还会按编辑器实际列宽再收）
const HINT_MIN_BORDER = 16; // 上边框至少保留的 ─ 列数，避免盒子看起来残缺

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
  fp: string;
  parts?: HintParts;
}

interface HintState {
  /** 检查当前生效的编辑器工厂是否仍是我们的包装，被其他扩展替换则重新包装。返回是否刚重新包装。 */
  ensure: () => boolean;
  requestRender: (force?: boolean) => void;
}

let hintCache: HintCache = { fp: "" };
let stopSubscribe: (() => void) | undefined;
const hintSessions = new Set<HintState>();

function computeHintParts(
  ws: WorkspaceInfo | undefined,
  editorCtx: EditorContext | undefined,
): HintParts | undefined {
  if (!ws || ws.folders.length === 0) return undefined;
  // Windows 路径大小写不敏感，统一小写比较（同 buildWorkspaceSystemPrompt）
  const cwdLower = process.cwd().toLowerCase();
  const cwdFolder = ws.folders.find((f) => f.path.toLowerCase() === cwdLower) ?? ws.folders[0];

  let root = cwdFolder.name;
  let file = "";
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

/** render 只读缓存；内容由 subscribe_ide 推送更新 */
function getHintParts(): HintParts | undefined {
  return hintCache.parts;
}

function syncHintCache(): boolean {
  const parts = computeHintParts(liveWorkspace, liveContext);
  const fp = JSON.stringify(parts ?? null);
  if (fp === hintCache.fp) return false;
  hintCache = { fp, parts };
  return true;
}

function applyIdePush(data: IdeSubscribeData): boolean {
  if ("context" in data) {
    haveLiveContext = true;
    liveContext = parseEditorContext(data.context);
  }
  if ("workspace" in data) {
    haveLiveWorkspace = true;
    liveWorkspace = parseWorkspace(data.workspace);
  }
  return syncHintCache();
}

function notifyHintSessions(changed: boolean): void {
  for (const session of [...hintSessions]) {
    try {
      const rewrapped = session.ensure();
      if (rewrapped) session.requestRender(true);
      else if (changed) session.requestRender();
    } catch {
      hintSessions.delete(session);
    }
  }
}

function startIdeSubscription(): void {
  if (stopSubscribe || !hasIpc()) return;
  stopSubscribe = subscribeIde((data) => {
    notifyHintSessions(applyIdePush(data));
  });
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

function registerWorkspaceHint(pi: ExtensionAPI): void {
  let hintState: HintState | undefined;
  const delayTimers: ReturnType<typeof setTimeout>[] = [];

  const stopHintSession = () => {
    for (const t of delayTimers) clearTimeout(t);
    delayTimers.length = 0;
    if (hintState) hintSessions.delete(hintState);
    hintState = undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    stopHintSession();
    let tuiRef: { requestRender(force?: boolean): void } | undefined;
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
    // 扩展是异步逐个加载的，pi-open-tui 可能在我们之后才注册它的工厂。
    // 数据靠 subscribe_ide 推送；这里只在启动延迟和每次推送时重新包装。
    const ensureWrapped = (): boolean => {
      try {
        const current = ctx.ui.getEditorComponent();
        if (current === wrapperFactory) return false;
        innerFactory = current;
        ctx.ui.setEditorComponent(wrapperFactory);
        return true;
      } catch {
        stopHintSession();
        return false;
      }
    };
    ensureWrapped();
    hintState = {
      ensure: ensureWrapped,
      requestRender: (force?: boolean) => tuiRef?.requestRender(force),
    };
    hintSessions.add(hintState);
    if (hintCache.parts) hintState.requestRender();
    // pi-open-tui 会在 session_start 里清屏（\x1b[2J），TUI 不知情仍做差分刷新，
    // 欢迎页/边框留在 previousLines 里以为没变，屏幕就空了。拖动分割条会走
    // requestRender(true) → resetRenderState → 全量重绘才恢复。
    // 普通 requestRender() 不够；启动后强制全量重绘几次，并顺带重新包装工厂。
    for (const ms of [50, 250, 800, 2000]) {
      const t = setTimeout(() => {
        hintState?.ensure();
        hintState?.requestRender(true);
      }, ms);
      t.unref?.();
      delayTimers.push(t);
    }
  });

  // 会话 ctx 会在 /reload、/new、/resume、/fork 时失效
  pi.on("session_shutdown", () => {
    stopHintSession();
  });
}
