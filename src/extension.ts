// pi-for-vscode 扩展宿主（极简版）
// 职责：编辑器区分屏打开 pi 终端 + 把编辑器上下文写入共享文件供 pi 扩展注入系统提示词。
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { registerUpdateChecker } from './update.js';

/** 当前工作区的隔离 key（与 pi 扩展端用同一编码：cwd 非字母数字转 -，并转小写） */
function workspaceKey(): string {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return folder ? folder.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase() : 'no-workspace';
}

/** 本工作区专属目录（多 VSCode 窗口互不干扰） */
function ideDir(): string {
  return path.join(os.homedir(), '.pi', 'agent', 'vscode-ide', workspaceKey());
}

/** 共享上下文文件路径（pi 扩展读取此文件注入系统提示词） */
function contextFilePath(): string {
  return path.join(ideDir(), 'context.json');
}

/** 工作区诊断文件路径（pi 扩展的工具读取此文件） */
function diagnosticsFilePath(): string {
  return path.join(ideDir(), 'diagnostics.json');
}

interface DiagnosticItem {
  /** 工作区相对路径 */
  file: string;
  /** 1 起始行号 */
  line: number;
  /** 1 起始列号 */
  col: number;
  severity: 'error' | 'warning';
  message: string;
  source?: string;
}

/** 诊断条数上限（防止巨型工作区撑爆文件） */
const MAX_DIAGNOSTICS = 200;

/** 收集工作区诊断（仅 error/warning）并写盘。事件驱动 + 指纹去重。 */
let lastDiagnosticsWritten = '';
function writeDiagnostics(): void {
  const all = vscode.languages.getDiagnostics();
  const items: DiagnosticItem[] = [];
  for (const [uri, diags] of all) {
    if (uri.scheme !== 'file') continue;
    const rel = vscode.workspace.asRelativePath(uri, false);
    for (const d of diags) {
      if (d.severity > vscode.DiagnosticSeverity.Warning) continue;
      items.push({
        file: rel,
        line: d.range.start.line + 1,
        col: d.range.start.character + 1,
        severity: d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning',
        message: d.message.split('\n')[0].slice(0, 300),
        source: d.source,
      });
      if (items.length >= MAX_DIAGNOSTICS) break;
    }
    if (items.length >= MAX_DIAGNOSTICS) break;
  }
  // 排序：error 优先，再按文件与行号
  items.sort((a, b) => (a.severity === b.severity ? a.file.localeCompare(b.file) || a.line - b.line : a.severity === 'error' ? -1 : 1));

  const total = all.reduce((n, [, ds]) => n + ds.filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning).length, 0);
  const payload = JSON.stringify({ updatedAt: Date.now(), total, truncated: total > items.length, diagnostics: items });
  if (payload === lastDiagnosticsWritten) return;
  lastDiagnosticsWritten = payload;
  void fs.promises
    .mkdir(path.dirname(diagnosticsFilePath()), { recursive: true })
    .then(() => fs.promises.writeFile(diagnosticsFilePath(), payload, 'utf8'))
    .catch(() => undefined);
}

interface EditorContext {
  /** 是否启用注入 */
  enabled: boolean;
  /** 活动编辑器文件（工作区相对路径） */
  activeFile?: string;
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
  if (doc.uri.scheme !== 'file') return undefined;

  const base: EditorContext = { enabled: contextEnabled, updatedAt: Date.now() };
  base.activeFile = vscode.workspace.asRelativePath(doc.uri, false);
  base.language = doc.languageId;

  const sel = editor.selection;
  if (sel && !sel.isEmpty) {
    const text = doc.getText(sel);
    const lines = text.split('\n');
    const truncated = lines.length > maxLines;
    base.selection = truncated ? `${lines.slice(0, maxLines).join('\n')}\n…(已截断，共 ${lines.length} 行)` : text;
    base.selectionStartLine = sel.start.line + 1;
    base.selectionEndLine = sel.end.line + 1;
  } else if (sel) {
    base.cursorLine = sel.active.line + 1;
  }
  return base;
}

/** 把上下文写盘（pi 扩展读取）。仅在内容变化时写，避免无谓 IO。 */
let lastWritten = '';
function writeContext(): void {
  if (!contextEnabled) {
    // 关闭时写 enabled=false，让 pi 扩展停止注入
    writeRaw(JSON.stringify({ enabled: false, updatedAt: Date.now() } satisfies EditorContext));
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
    .then(() => fs.promises.writeFile(contextFilePath(), payload, 'utf8'))
    .catch(() => undefined);
}

/** 已打开的 pi 终端计数（用于编号命名，支持多会话并存） */
let piTerminalCount = 0;

function readConfig(): void {
  const cfg = vscode.workspace.getConfiguration('pi-for-vscode');
  contextEnabled = cfg.get<boolean>('context.enabled', true);
  maxLines = cfg.get<number>('context.maxLines', 200);
}

let extensionPath = '';

/** 在 PATH 中探测 pi 可执行文件（Windows 优先 pi.exe/pi.cmd） */
function findPiExecutable(): string | undefined {
  const pathEnv = process.env.PATH ?? '';
  const names = process.platform === 'win32' ? ['pi.exe', 'pi.cmd', 'pi.bat'] : ['pi'];
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
  const cfg = vscode.workspace.getConfiguration('pi-for-vscode');
  const splitRight = cfg.get<boolean>('terminal.splitRight', true);

  const piPath = findPiExecutable();
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  piTerminalCount += 1;
  const name = piTerminalCount === 1 ? 'pi' : `pi #${piTerminalCount}`;

  const terminal = piPath
    ? // pi 进程直接作为终端 shell：pi 一退出，终端随之关闭
      vscode.window.createTerminal({
        name,
        location: vscode.TerminalLocation.Editor,
        shellPath: piPath,
        cwd,
        iconPath: {
          light: vscode.Uri.file(path.join(extensionPath, 'media', 'pi.svg')),
          dark: vscode.Uri.file(path.join(extensionPath, 'media', 'pi-dark.svg')),
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
    terminal.sendText('pi', true);
  }

  if (splitRight) {
    // 把编辑器区的终端移到右侧分屏
    await vscode.commands.executeCommand('workbench.action.moveEditorToRightGroup').then(undefined, () => undefined);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  extensionPath = context.extensionPath;
  readConfig();

  context.subscriptions.push(
    vscode.commands.registerCommand('pi-for-vscode.openTerminal', () => void openPiTerminal()),
    // 编辑器/选区变化时刷新上下文
    vscode.window.onDidChangeActiveTextEditor(() => writeContext()),
    vscode.window.onDidChangeTextEditorSelection(() => writeContext()),
    // 诊断变化时刷新诊断文件
    vscode.languages.onDidChangeDiagnostics(() => writeDiagnostics()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('pi-for-vscode')) {
        readConfig();
        writeContext();
      }
    }),
  );

  // 启动时写一次上下文与诊断
  writeContext();
  writeDiagnostics();

  // 自动检查更新（含手动命令注册）
  registerUpdateChecker(context);
}

export function deactivate(): void {
  // 退出时清空上下文，避免过期数据被注入
  try {
    fs.writeFileSync(contextFilePath(), JSON.stringify({ enabled: false, updatedAt: Date.now() }), 'utf8');
  } catch {
    /* 忽略 */
  }
}
