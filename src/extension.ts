// pi-for-vscode 扩展宿主（极简版）
// 职责：编辑器区分屏打开 pi 终端 + 把编辑器上下文写入共享文件供 pi 扩展注入系统提示词。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { syncPiExtensions } from "./sync-pi-extension.js";
import { registerUpdateChecker } from "./update.js";

/** 当前工作区的隔离 key（与 pi 扩展端用同一编码：cwd 非字母数字转 -，并转小写） */
function workspaceKey(): string {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return folder
    ? folder.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()
    : "no-workspace";
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

/** 诊断请求文件路径（pi 扩展写入，本扩展 fs.watch 监听） */
function diagnosticsRequestPath(): string {
  return path.join(ideDir(), "diagnostics-request.json");
}

/** 诊断响应文件路径（本扩展写入，pi 扩展轮询） */
function diagnosticsResponsePath(): string {
  return path.join(ideDir(), "diagnostics-response.json");
}

/** 工作区结构文件路径（pi 扩展读取此文件注入根目录列表） */
function workspaceFilePath(): string {
  return path.join(ideDir(), "workspace.json");
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

/** 收集工作区诊断（仅 error/warning），按根目录分组写盘。事件驱动 + 指纹去重。
 * 返回写盘 Promise（按需诊断流程需要 await 它刷新完成后再写响应）。 */
let lastDiagnosticsWritten = "";
function writeDiagnostics(): Promise<void> {
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
        severity:
          d.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning",
        message: d.message.split("\n")[0].slice(0, 300),
        source: d.source,
      });
      kept += 1;
    }
  }

  // 每根内排序：error 优先，再按文件与行号
  const roots = [...byRoot.values()].sort((a, b) =>
    a.rootName.localeCompare(b.rootName),
  );
  for (const r of roots) {
    r.diagnostics.sort((a, b) =>
      a.severity === b.severity
        ? a.file.localeCompare(b.file) || a.line - b.line
        : a.severity === "error"
          ? -1
          : 1,
    );
  }

  const payload = JSON.stringify({
    updatedAt: Date.now(),
    total,
    truncated: total > kept,
    roots,
  });
  if (payload === lastDiagnosticsWritten) return Promise.resolve();
  lastDiagnosticsWritten = payload;
  return fs.promises
    .mkdir(path.dirname(diagnosticsFilePath()), { recursive: true })
    .then(() => fs.promises.writeFile(diagnosticsFilePath(), payload, "utf8"))
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// 按需诊断（pi 扩展 -> 本扩展的请求/响应通道）
//
// 某些语言扩展（如 Vue/Volar）只对「已打开」的文档做诊断，未打开文件在
// diagnostics.json 里永远是空白。pi 侧工具通过 diagnose 参数把文件列表写进
// diagnostics-request.json，本扩展监听后打开这些文档，等诊断事件到达，
// 再把每个文件的状态与诊断写进 diagnostics-response.json 供 pi 轮询。
//
// 关键机制（均已从 VSCode / vscode-languageserver / volar.js 源码验证）：
// - openTextDocument 无头打开不弹 tab、不切焦点，但同样触发 onDidOpenTextDocument，
//   LSP 客户端会向服务端发 didOpen（与可见性无关）；
// - volar.js 的 push 诊断在 didOpen 时也会触发（TextDocuments 的 didOpen 同时
//   fire onDidChangeContent），且干净文件同样发布空诊断数组；
// - DiagnosticCollection.set(uri, []) 对新 URI 无条件触发 onDidChangeDiagnostics。
// ---------------------------------------------------------------------------

interface DiagnoseRequest {
  id: string;
  /** 绝对路径列表 */
  files: string[];
}

interface DiagnoseResponseItem {
  /** 1 起始行号 */
  line: number;
  /** 1 起始列 */
  col: number;
  severity: "error" | "warning";
  message: string;
  source?: string;
}

interface DiagnoseResponseFile {
  /** 绝对路径 */
  file: string;
  /** analyzed=收到过诊断信号；uncertain=等满超时仍无信号；not-found=文件打不开 */
  status: "analyzed" | "uncertain" | "not-found";
  items: DiagnoseResponseItem[];
}

interface DiagnoseResponse {
  id: string;
  openMode: "headless" | "visible";
  files: DiagnoseResponseFile[];
}

/** 单请求文件数上限（防误用，与 pi 侧上限一致） */
const DIAGNOSE_MAX_FILES = 50;
/** 新打开文档等待诊断事件的超时：覆盖语言服务冷启动（Volar 自身就有 250ms 防抖 + 每文档 250ms 间隔） */
const DIAGNOSE_NEW_DOC_WAIT_MS = 15_000;
/** 已打开文档的重新分析等待：磁盘变更 -> 模型回退 -> 重新发布一般 1s 内 */
const DIAGNOSE_OPEN_DOC_WAIT_MS = 3_000;
/** 单文件诊断条数上限 */
const DIAGNOSE_MAX_ITEMS_PER_FILE = 100;

let lastDiagnoseRequestId = "";
let diagnoseInFlight = false;
let diagnoseQueued = false;

/** 诊断会话期间抑制编辑器上下文写入（visible 模式会切换活动编辑器，避免污染 activeFile） */
let contextSuppressUntil = 0;

/** URI 比较键：toString 小写化（归一 Windows 盘符大小写与服务端回显差异） */
function uriKey(uri: vscode.Uri): string {
  return uri.toString().toLowerCase();
}

/** 监听诊断请求文件。fs.watch 对目录监听在 Windows/Linux/macOS 均返回文件名。 */
function watchDiagnosticsRequests(context: vscode.ExtensionContext): void {
  try {
    fs.mkdirSync(ideDir(), { recursive: true });
    const watcher = fs.watch(ideDir(), (_event, filename) => {
      if (path.basename(String(filename ?? "")) === "diagnostics-request.json") {
        scheduleDiagnoseRequest();
      }
    });
    // 目录被删除/重建等异常时避免未捕获错误，直接放弃监听（下次激活恢复）
    watcher.on("error", (err) =>
      console.error("[pi-for-vscode] 诊断请求监听异常:", err),
    );
    context.subscriptions.push({ dispose: () => watcher.close() });
  } catch (err) {
    console.error("[pi-for-vscode] 监听诊断请求目录失败:", err);
    return;
  }
  // 激活时处理窗口重载前遗留的新鲜请求（pi 可能恰好在重载期间写入）
  try {
    const stat = fs.statSync(diagnosticsRequestPath());
    if (Date.now() - stat.mtimeMs < 60_000) scheduleDiagnoseRequest();
  } catch {
    /* 尚无请求文件 */
  }
}

function scheduleDiagnoseRequest(): void {
  if (diagnoseInFlight) {
    diagnoseQueued = true;
    return;
  }
  diagnoseInFlight = true;
  void handleDiagnoseRequest()
    .catch((err) => console.error("[pi-for-vscode] 处理诊断请求失败:", err))
    .finally(() => {
      diagnoseInFlight = false;
      if (diagnoseQueued) {
        diagnoseQueued = false;
        scheduleDiagnoseRequest();
      }
    });
}

async function handleDiagnoseRequest(): Promise<void> {
  let req: DiagnoseRequest | undefined;
  try {
    req = JSON.parse(
      await fs.promises.readFile(diagnosticsRequestPath(), "utf8"),
    ) as DiagnoseRequest;
  } catch {
    return;
  }
  if (!req || typeof req.id !== "string" || !Array.isArray(req.files)) return;
  if (req.id === lastDiagnoseRequestId) return; // fs.watch 重复事件
  lastDiagnoseRequestId = req.id;

  const visible = diagnosticsOpenMode === "visible";
  const results: DiagnoseResponseFile[] = [];
  // key -> 截止时间；诊断事件到达或超时后移除
  const pending = new Map<string, number>();
  // 收到过诊断事件的 key（与 pending 分开记录，用于最终判定 analyzed）
  const eventSeen = new Set<string>();
  const openedKeys = new Set<string>();
  const startedAt = Date.now();
  const prevActiveEditor = vscode.window.activeTextEditor;

  for (const raw of req.files.slice(0, DIAGNOSE_MAX_FILES)) {
    const file = typeof raw === "string" ? raw : "";
    if (!file || !path.isAbsolute(file) || !fs.existsSync(file)) {
      results.push({ file: file || "(空路径)", status: "not-found", items: [] });
      continue;
    }
    try {
      const uri = vscode.Uri.file(file);
      const key = uriKey(uri);
      const wasOpen = vscode.workspace.textDocuments.some(
        (d) => uriKey(d.uri) === key,
      );
      const doc = await vscode.workspace.openTextDocument(uri);
      openedKeys.add(key);
      if (visible) {
        // 会话期间持续抑制；会话结束时再顺延一小段时间
        contextSuppressUntil = Date.now() + 120_000;
        await vscode.window
          .showTextDocument(doc, { preview: true, preserveFocus: true })
          .then(undefined, () => undefined);
      }
      pending.set(
        key,
        startedAt +
          (wasOpen ? DIAGNOSE_OPEN_DOC_WAIT_MS : DIAGNOSE_NEW_DOC_WAIT_MS),
      );
      results.push({ file, status: "uncertain", items: [] });
    } catch {
      results.push({ file, status: "not-found", items: [] });
    }
  }

  // 等待诊断事件（事件驱动 + 截止时间兑底）
  if (pending.size > 0) {
    await new Promise<void>((resolve) => {
      let sub: vscode.Disposable | undefined;
      let timer: NodeJS.Timeout | undefined;
      const finish = () => {
        sub?.dispose();
        if (timer) clearInterval(timer);
        resolve();
      };
      const sweep = () => {
        const now = Date.now();
        for (const [key, deadline] of pending) {
          if (now >= deadline) pending.delete(key);
        }
        if (pending.size === 0) finish();
      };
      sub = vscode.languages.onDidChangeDiagnostics((e) => {
        for (const u of e.uris) {
          const key = uriKey(u);
          if (pending.delete(key)) eventSeen.add(key);
        }
        sweep();
      });
      timer = setInterval(sweep, 200);
    });
  }

  // 收集每个文件的结果：published 含「发布过空数组」的 URI（干净文件也会入集合）
  const published = new Map<string, vscode.Diagnostic[]>();
  for (const [uri, diags] of vscode.languages.getDiagnostics()) {
    published.set(uriKey(uri), diags);
  }
  for (const r of results) {
    if (r.status !== "uncertain") continue;
    const key = uriKey(vscode.Uri.file(r.file));
    if (eventSeen.has(key) || published.has(key)) r.status = "analyzed";
    r.items = (published.get(key) ?? [])
      .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning)
      .slice(0, DIAGNOSE_MAX_ITEMS_PER_FILE)
      .map((d) => ({
        line: d.range.start.line + 1,
        col: d.range.start.character + 1,
        severity:
          d.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning",
        message: d.message.split("\n")[0].slice(0, 300),
        source: d.source,
      }));
  }

  // 先刷新 diagnostics.json（后台状态保持新鲜），再写响应，避免 pi 读到旧数据
  await writeDiagnostics();
  const response: DiagnoseResponse = {
    id: req.id,
    openMode: visible ? "visible" : "headless",
    files: results,
  };
  try {
    await fs.promises.writeFile(
      diagnosticsResponsePath(),
      JSON.stringify(response),
      "utf8",
    );
  } catch {
    /* 写失败：pi 侧会超时报错 */
  }

  if (visible) {
    // 用户没有自行切走（活动编辑器仍是本次会话打开的）时恢复会话前的活动编辑器
    const current = vscode.window.activeTextEditor;
    const isOurs =
      current !== undefined && openedKeys.has(uriKey(current.document.uri));
    if (prevActiveEditor && isOurs) {
      await vscode.window
        .showTextDocument(prevActiveEditor.document, {
          viewColumn: prevActiveEditor.viewColumn,
          preview: true,
        })
        .then(undefined, () => undefined);
    }
    contextSuppressUntil = Date.now() + 1_500;
    // 恢复成功或用户已自行切换时刷新上下文；仍停在预览 tab 上时保留旧上下文（宁 stale 不污染）
    const after = vscode.window.activeTextEditor;
    if (!after || !openedKeys.has(uriKey(after.document.uri))) {
      setTimeout(() => writeContext(), 1_600);
    }
  }
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
  const folders: WorkspaceFolderInfo[] = (
    vscode.workspace.workspaceFolders ?? []
  ).map((f) => ({
    name: f.name,
    path: f.uri.fsPath,
  }));
  const payload = JSON.stringify({ updatedAt: Date.now(), folders });
  if (payload === lastWorkspaceWritten) return;
  lastWorkspaceWritten = payload;
  void fs.promises
    .mkdir(path.dirname(workspaceFilePath()), { recursive: true })
    .then(() => fs.promises.writeFile(workspaceFilePath(), payload, "utf8"))
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
/** 按需诊断的打开方式：headless 无头打开（默认，不弹 tab）；visible 预览 tab 打开（兼容只诊断可见编辑器的扩展） */
let diagnosticsOpenMode: "headless" | "visible" = "headless";

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

/** 把上下文写盘（pi 扩展读取）。仅在内容变化时写，避免无谓 IO。 */
let lastWritten = "";
function writeContext(): void {
  // 诊断会话期间抑制：visible 模式会切换活动编辑器，此时写入会污染 activeFile
  if (Date.now() < contextSuppressUntil) return;
  if (!contextEnabled) {
    // 关闭时写 enabled=false，让 pi 扩展停止注入
    writeRaw(
      JSON.stringify({
        enabled: false,
        updatedAt: Date.now(),
      } satisfies EditorContext),
    );
    return;
  }
  const ctx = collectContext();
  // 关键：焦点在终端/面板（无活动文本编辑器）时保留上一次的有效上下文，
  // 不用空内容覆盖——否则打开 pi 终端后上下文立即丢失。
  if (!ctx) return;
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
  diagnosticsOpenMode =
    cfg.get<string>("diagnostics.openMode", "headless") === "visible"
      ? "visible"
      : "headless";
}

let extensionPath = "";

/** 在 PATH 中探测 pi 可执行文件（Windows 优先 pi.exe/pi.cmd） */
function findPiExecutable(): string | undefined {
  const pathEnv = process.env.PATH ?? "";
  const names =
    process.platform === "win32" ? ["pi.exe", "pi.cmd", "pi.bat"] : ["pi"];
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

  const terminal = piPath
    ? // pi 进程直接作为终端 shell：pi 一退出，终端随之关闭
      vscode.window.createTerminal({
        name,
        location: vscode.TerminalLocation.Editor,
        shellPath: piPath,
        cwd,
        iconPath: {
          light: vscode.Uri.file(path.join(extensionPath, "media", "pi.svg")),
          dark: vscode.Uri.file(
            path.join(extensionPath, "media", "pi-dark.svg"),
          ),
        },
      })
    : // 找不到 pi 可执行文件时回退：普通终端里跑 pi（pi 退出后回到 shell）
      vscode.window.createTerminal({
        name,
        location: vscode.TerminalLocation.Editor,
        cwd,
      });
  terminal.show();
  if (!piPath) {
    terminal.sendText("pi", true);
  }

  if (splitRight) {
    // 把编辑器区的终端移到右侧分屏
    await vscode.commands
      .executeCommand("workbench.action.moveEditorToRightGroup")
      .then(undefined, () => undefined);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  extensionPath = context.extensionPath;
  readConfig();

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "pi-for-vscode.openTerminal",
      () => void openPiTerminal(),
    ),
    // 编辑器/选区变化时刷新上下文
    vscode.window.onDidChangeActiveTextEditor(() => writeContext()),
    vscode.window.onDidChangeTextEditorSelection(() => writeContext()),
    // 诊断变化时刷新诊断文件
    vscode.languages.onDidChangeDiagnostics(() => void writeDiagnostics()),
    // 根目录增删时刷新工作区结构
    vscode.workspace.onDidChangeWorkspaceFolders(() => writeWorkspaceInfo()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("pi-for-vscode")) {
        readConfig();
        writeContext();
      }
    }),
  );

  // 启动时写一次上下文、诊断、工作区结构
  writeContext();
  void writeDiagnostics();
  writeWorkspaceInfo();

  // 监听 pi 侧的按需诊断请求
  watchDiagnosticsRequests(context);

  // 同步 pi 端扩展文件到 ~/.pi/agent/extensions/（版本升级后自动覆盖旧版）
  void syncPiExtensions(context);

  // 自动检查更新（含手动命令注册）
  registerUpdateChecker(context);
}

export function deactivate(): void {
  // 退出时清空上下文，避免过期数据被注入
  try {
    fs.writeFileSync(
      contextFilePath(),
      JSON.stringify({ enabled: false, updatedAt: Date.now() }),
      "utf8",
    );
  } catch {
    /* 忽略 */
  }
}
