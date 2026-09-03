// pi-for-vscode 扩展宿主（极简版）
// 职责：编辑器区分屏打开 pi 终端 + 把编辑器上下文写入共享文件供 pi 扩展注入系统提示词。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  maybePromptAutoApprove,
  startBrowserIpc,
  type BrowserIpcHandle,
} from "./browser-ipc.js";
import { publishIdeSnapshot } from "./ide-store.js";
import { syncPiExtensions } from "./sync-pi-extension.js";
import { registerUpdateChecker } from "./update.js";

/** 当前工作区的隔离 key（与 pi 扩展端用同一编码：cwd 非字母数字转 -，并转小写） */
function workspaceKey(): string {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return folder ? folder.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase() : "no-workspace";
}

/** 本工作区专属目录（多 VSCode 窗口互不干扰） */
function ideDir(): string {
  return path.join(os.homedir(), ".pi", "agent", "vscode-ide", workspaceKey());
}

/** 共享上下文文件路径（pi 扩展读取此文件注入系统提示词） */
function contextFilePath(): string {
  return path.join(ideDir(), "context.json");
}

/** 工作区诊断文件路径（pi 扩展的工具读取此文件） */
function diagnosticsFilePath(): string {
  return path.join(ideDir(), "diagnostics.json");
}

/** 工作区结构文件路径（pi 扩展读取此文件注入根目录列表） */
function workspaceFilePath(): string {
  return path.join(ideDir(), "workspace.json");
}

/** 语言配置快照文件（pi 侧的 run_diagnostics 工具读取，用于 CLI 与编辑器配置一致） */
function languageConfigPath(): string {
  return path.join(ideDir(), "language-config.json");
}

interface DiagnosticItem {
  /** 相对所属根目录的路径 */
  file: string;
  /** 1 起始行号 */
  line: number;
  /** 1 起始列号 */
  col: number;
  severity: "error" | "warning";
  message: string;
  source?: string;
}

/** 单根目录下的诊断集合 */
interface RootDiagnostics {
  /** 根目录绝对路径 */
  root: string;
  /** 根目录显示名（workspace folder name） */
  rootName: string;
  diagnostics: DiagnosticItem[];
}

/** 诊断条数上限（防止巨型工作区撑爆文件，按全部根合计） */
const MAX_DIAGNOSTICS = 200;

/** 收集工作区诊断（仅 error/warning），按根目录分组写盘。事件驱动 + 指纹去重。 */
let lastDiagnosticsWritten = "";
function writeDiagnostics(): void {
  const all = vscode.languages.getDiagnostics();
  const byRoot = new Map<string, RootDiagnostics>();
  let total = 0;
  let kept = 0;

  for (const [uri, diags] of all) {
    if (uri.scheme !== "file") continue;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    // 不属于任何根的文件不写入（诊断只关心工作区内）
    if (!folder) continue;
    const rel = path.relative(folder.uri.fsPath, uri.fsPath);

    for (const d of diags) {
      if (d.severity > vscode.DiagnosticSeverity.Warning) continue;
      total += 1;
      if (kept >= MAX_DIAGNOSTICS) continue;
      let bucket = byRoot.get(folder.uri.fsPath);
      if (!bucket) {
        bucket = {
          root: folder.uri.fsPath,
          rootName: folder.name,
          diagnostics: [],
        };
        byRoot.set(folder.uri.fsPath, bucket);
      }
      bucket.diagnostics.push({
        file: rel,
        line: d.range.start.line + 1,
        col: d.range.start.character + 1,
        severity: d.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning",
        message: d.message.split("\n")[0].slice(0, 300),
        source: d.source,
      });
      kept += 1;
    }
  }

  // 每根内排序：error 优先，再按文件与行号
  const roots = [...byRoot.values()].sort((a, b) => a.rootName.localeCompare(b.rootName));
  for (const r of roots) {
    r.diagnostics.sort((a, b) =>
      a.severity === b.severity
        ? a.file.localeCompare(b.file) || a.line - b.line
        : a.severity === "error"
          ? -1
          : 1,
    );
  }

  const obj = {
    updatedAt: Date.now(),
    total,
    truncated: total > kept,
    roots,
  };
  publishIdeSnapshot("diagnostics", obj);
  const payload = JSON.stringify(obj);
  if (payload === lastDiagnosticsWritten) return;
  lastDiagnosticsWritten = payload;
  void fs.promises
    .mkdir(path.dirname(diagnosticsFilePath()), { recursive: true })
    .then(() => fs.promises.writeFile(diagnosticsFilePath(), payload, "utf8"))
    .catch(() => undefined);
}

interface WorkspaceFolderInfo {
  /** 根目录显示名 */
  name: string;
  /** 根目录绝对路径 */
  path: string;
}

/** 写入工作区结构（根目录列表）。启动 + 根目录变化时调用。 */
let lastWorkspaceWritten = "";
function writeWorkspaceInfo(): void {
  const folders: WorkspaceFolderInfo[] = (vscode.workspace.workspaceFolders ?? []).map((f) => ({
    name: f.name,
    path: f.uri.fsPath,
  }));
  const obj = { updatedAt: Date.now(), folders };
  publishIdeSnapshot("workspace", obj);
  const payload = JSON.stringify(obj);
  if (payload === lastWorkspaceWritten) return;
  lastWorkspaceWritten = payload;
  void fs.promises
    .mkdir(path.dirname(workspaceFilePath()), { recursive: true })
    .then(() => fs.promises.writeFile(workspaceFilePath(), payload, "utf8"))
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// 语言配置快照导出
//
// pi 进程在终端，拿不到 VSCode 合并后的语言扩展配置（默认值+用户设置+工作区
// 设置+语言段覆盖等）。这里用 getConfiguration(section, { resource, languageId })
// 拿到与编辑器「逐位一致」的最终生效值，经 named pipe 给 pi 侧 run_diagnostics；
// language-config.json 只作调试落盘。
//
// 关键：语言段覆盖（如 "[python]": {...}、"[vue]": {...}）只在传入 languageId
// 时生效；folder 级配置需要传入 resource（用第一个工作区根目录作代表）。
// ---------------------------------------------------------------------------

interface LanguageConfigSnapshot {
  updatedAt: number;
  /** 第一个工作区根目录绝对路径（作 resource 用途；无工作区时为 null） */
  resource: string | null;
  typescript: {
    /** 编辑器用的 TypeScript SDK 路径（typescript.tsdk） */
    tsdk: string | null;
  };
  basedpyright: {
    /** 配置文件 key = typeCheckingMode（同名字段，前缀剥离） */
    typeCheckingMode: string | null;
    /** 解释器路径：配置文件 key = pythonPath（VSCode key = python.defaultInterpreterPath，不同名） */
    interpreterPath: string | null;
    /** 虚拟环境目录：配置文件 key = venvPath（同名字段，VSCode key = python.venvPath） */
    venvPath: string | null;
  };
}

function firstWorkspaceResource(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/** 采集语言配置快照（与编辑器一致的最终值） */
function collectLanguageConfig(): LanguageConfigSnapshot {
  const resource = firstWorkspaceResource();

  // TypeScript：tsdk（编辑器用哪个 TypeScript 版本，CLI 就用同一个）
  // TypeScript 无语言段覆盖，直接用 resource 定位 folder/workspace 层配置
  const tsConfig = vscode.workspace.getConfiguration("typescript", resource);
  const tsdk = tsConfig.get<string>("tsdk") ?? null;

  // basedpyright：typeCheckingMode 是它自己的字段；解释器走 python 扩展
  const pyScope = resource !== undefined ? { uri: resource, languageId: "python" } : undefined;
  const bpConfig = vscode.workspace.getConfiguration("basedpyright.analysis", pyScope);
  const pythonConfig = vscode.workspace.getConfiguration("python", pyScope);

  return {
    updatedAt: Date.now(),
    resource: resource?.fsPath ?? null,
    typescript: {
      tsdk,
    },
    basedpyright: {
      typeCheckingMode: bpConfig.get<string>("typeCheckingMode") ?? null,
      interpreterPath: pythonConfig.get<string>("defaultInterpreterPath") ?? null,
      venvPath: pythonConfig.get<string>("venvPath") ?? null,
    },
  };
}

let lastLanguageConfigWritten = "";
function writeLanguageConfig(): void {
  const obj = collectLanguageConfig();
  publishIdeSnapshot("languageConfig", obj);
  const payload = JSON.stringify(obj);
  if (payload === lastLanguageConfigWritten) return;
  lastLanguageConfigWritten = payload;
  void fs.promises
    .mkdir(path.dirname(languageConfigPath()), { recursive: true })
    .then(() => fs.promises.writeFile(languageConfigPath(), payload, "utf8"))
    .catch(() => undefined);
}

interface EditorContext {
  /** 是否启用注入 */
  enabled: boolean;
  /** 活动编辑器文件：属于某根目录时是相对该根的路径；不属于任何根时是绝对路径 */
  activeFile?: string;
  /** 活动文件所属根目录绝对路径（不属于任何根时缺省） */
  activeFileRoot?: string;
  /** 活动文件所属根目录显示名（不属于任何根时缺省） */
  activeFileRootName?: string;
  /** 文件语言 id */
  language?: string;
  /** 选中内容（截断后） */
  selection?: string;
  /** 选区起始行（1 起始） */
  selectionStartLine?: number;
  /** 选区结束行 */
  selectionEndLine?: number;
  /** 光标所在行（1 起始，无选区时） */
  cursorLine?: number;
  /** 更新时间戳 */
  updatedAt: number;
}

let contextEnabled = true;
let maxLines = 200;

/** 收集当前编辑器上下文。无有效文本编辑器时返回 undefined（不覆盖旧上下文）。 */
function collectContext(): EditorContext | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;

  const doc = editor.document;
  // 跳过输出面板等非文件 scheme
  if (doc.uri.scheme !== "file") return undefined;

  const base: EditorContext = {
    enabled: contextEnabled,
    updatedAt: Date.now(),
  };
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  if (folder) {
    // 属于某根目录 → 存相对该根的路径 + 根信息
    base.activeFile = path.relative(folder.uri.fsPath, doc.uri.fsPath);
    base.activeFileRoot = folder.uri.fsPath;
    base.activeFileRootName = folder.name;
  } else {
    // 不属于任何根 → 直接存绝对路径
    base.activeFile = doc.uri.fsPath;
  }
  base.language = doc.languageId;

  const sel = editor.selection;
  if (sel && !sel.isEmpty) {
    const text = doc.getText(sel);
    const lines = text.split("\n");
    const truncated = lines.length > maxLines;
    base.selection = truncated
      ? `${lines.slice(0, maxLines).join("\n")}\n…(已截断，共 ${lines.length} 行)`
      : text;
    base.selectionStartLine = sel.start.line + 1;
    base.selectionEndLine = sel.end.line + 1;
  } else if (sel) {
    base.cursorLine = sel.active.line + 1;
  }
  return base;
}

/** 发布上下文快照（pipe）并调试落盘。仅在内容变化时写文件。 */
let lastWritten = "";
function writeContext(): void {
  if (!contextEnabled) {
    const disabled: EditorContext = { enabled: false, updatedAt: Date.now() };
    publishIdeSnapshot("context", disabled);
    writeRaw(JSON.stringify(disabled));
    return;
  }
  const ctx = collectContext();
  // 关键：焦点在终端/面板（无活动文本编辑器）时保留上一次的有效上下文，
  // 不用空内容覆盖——否则打开 pi 终端后上下文立即丢失。
  if (!ctx) return;
  publishIdeSnapshot("context", ctx);
  // 只更新时间戳以外的字段变化才重写（updatedAt 每次不同，比较时排除）
  const { updatedAt: _ignore, ...rest } = ctx;
  const fingerprint = JSON.stringify(rest);
  if (fingerprint === lastWritten) return;
  lastWritten = fingerprint;
  writeRaw(JSON.stringify(ctx));
}

function writeRaw(payload: string): void {
  void fs.promises
    .mkdir(path.dirname(contextFilePath()), { recursive: true })
    .then(() => fs.promises.writeFile(contextFilePath(), payload, "utf8"))
    .catch(() => undefined);
}

/** 已打开的 pi 终端计数（用于编号命名，支持多会话并存） */
let piTerminalCount = 0;

function readConfig(): void {
  const cfg = vscode.workspace.getConfiguration("pi-for-vscode");
  contextEnabled = cfg.get<boolean>("context.enabled", true);
  maxLines = cfg.get<number>("context.maxLines", 200);
}

let extensionPath = "";
let browserIpc: BrowserIpcHandle | undefined;

/** 在 PATH 中探测 pi 可执行文件（Windows 优先 pi.exe/pi.cmd） */
function findPiExecutable(): string | undefined {
  const pathEnv = process.env.PATH ?? "";
  const names = process.platform === "win32" ? ["pi.exe", "pi.cmd", "pi.bat"] : ["pi"];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        if (fs.existsSync(full)) return full;
      } catch {
        /* 忽略无权限目录 */
      }
    }
  }
  return undefined;
}

/** 每次点击新建一个 pi 终端（支持多个会话并存），pi 退出即终端关闭 */
async function openPiTerminal(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("pi-for-vscode");
  const splitRight = cfg.get<boolean>("terminal.splitRight", true);

  const piPath = findPiExecutable();
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  piTerminalCount += 1;
  const name = piTerminalCount === 1 ? "pi" : `pi #${piTerminalCount}`;

  // 直接在目标分屏创建。若先按 Editor 打开再 moveEditorToRightGroup，
  // pi 会在旧列宽下完成首帧；分屏后 VSCode 不一定发 resize，TUI 按过宽的
  // 上边框换行，整页看起来残缺，直到手动拖动分割条才恢复。
  const location = splitRight
    ? { viewColumn: vscode.ViewColumn.Beside }
    : vscode.TerminalLocation.Editor;

  const env = browserIpc?.env;
  const terminal = piPath
    ? // pi 进程直接作为终端 shell：pi 一退出，终端随之关闭
      vscode.window.createTerminal({
        name,
        location,
        shellPath: piPath,
        cwd,
        env,
        iconPath: {
          light: vscode.Uri.file(path.join(extensionPath, "media", "pi.svg")),
          dark: vscode.Uri.file(path.join(extensionPath, "media", "pi-dark.svg")),
        },
      })
    : // 找不到 pi 可执行文件时回退：普通终端里跑 pi（pi 退出后回到 shell）
      vscode.window.createTerminal({
        name,
        location,
        cwd,
        env,
      });
  terminal.show();
  if (!piPath) {
    terminal.sendText("pi", true);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  extensionPath = context.extensionPath;
  readConfig();

  browserIpc = startBrowserIpc();
  context.subscriptions.push({ dispose: () => browserIpc?.dispose() });
  void maybePromptAutoApprove(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("pi-for-vscode.openTerminal", () => void openPiTerminal()),
    // 编辑器/选区变化时刷新上下文
    vscode.window.onDidChangeActiveTextEditor(() => writeContext()),
    vscode.window.onDidChangeTextEditorSelection(() => writeContext()),
    // 诊断变化时刷新诊断文件
    vscode.languages.onDidChangeDiagnostics(() => writeDiagnostics()),
    // 根目录增删时刷新工作区结构
    vscode.workspace.onDidChangeWorkspaceFolders(() => writeWorkspaceInfo()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("pi-for-vscode")) {
        readConfig();
        writeContext();
      }
      // 语言相关配置变化时刷新快照（typescript/basedpyright/python）
      if (
        e.affectsConfiguration("typescript") ||
        e.affectsConfiguration("basedpyright") ||
        e.affectsConfiguration("python")
      ) {
        writeLanguageConfig();
      }
    }),
  );

  // 启动时写一次上下文、诊断、工作区结构、语言配置
  writeContext();
  writeDiagnostics();
  writeWorkspaceInfo();
  writeLanguageConfig();

  // 同步 pi 端扩展文件到 ~/.pi/agent/extensions/（版本升级后自动覆盖旧版）
  void syncPiExtensions(context);

  // 自动检查更新（含手动命令注册）
  registerUpdateChecker(context);
}

export function deactivate(): void {
  // 退出时按设置写调试 JSON。设置开启时不置 false：reload 后会重新激活并刷新快照。
  try {
    const obj = { enabled: contextEnabled, updatedAt: Date.now() };
    publishIdeSnapshot("context", obj);
    fs.writeFileSync(contextFilePath(), JSON.stringify(obj), "utf8");
  } catch {
    /* 忽略 */
  }
}
