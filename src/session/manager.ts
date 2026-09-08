import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  promises as fs,
  watch,
  type FSWatcher,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { IPty } from "node-pty";
import * as vscode from "vscode";
import { PiPseudoterminal } from "../terminal/native-terminal.js";
import { win32Spawn } from "../terminal/pi-command.js";
import {
  createForkedSession,
  createNativeDraftFile,
  listSessionUserMessages,
  prepareRewindSession,
  removeNativeDraftFile,
  resolveSessionSnapshot,
  restoreWorktreeSnapshot,
  rewriteSessionFile,
  worktreeDiffersFromSnapshot,
} from "./actions.js";
import {
  becameIdle,
  PiStatusBridge,
  type PiSessionState,
  type PiStatusReport,
} from "./status-bridge.js";
import {
  deleteSessionFiles,
  listWorkspaceSessions,
  NEW_SESSION_TITLE,
  sessionDirectoriesForWorkspace,
  type PiSession,
} from "./store.js";
import { TerminalReplay } from "../terminal/replay.js";
import { normalizeViewState, setArchived, type PiViewState } from "./view-state.js";
import { coerceWorkspaceCwd, rootNameForCwd, type WorkspaceRoot } from "./workspace.js";

const require = createRequire(import.meta.url);
let ptyModule: typeof import("node-pty") | undefined;

function getPty(): typeof import("node-pty") {
  ptyModule ??= require("node-pty") as typeof import("node-pty");
  return ptyModule;
}

interface RunningSession {
  tabId: string;
  sessionId: string;
  startedAtMs: number;
  title: string;
  cwd: string;
  path?: string;
  leafId?: string;
  /** True only while this session is bound to the shared Terminal Editor. */
  attached: boolean;
  process: IPty;
  replay: TerminalReplay;
  cols: number;
  rows: number;
}

interface StartSessionOptions {
  nativeDraftFile?: string;
  reportError?: boolean;
  /** 后台恢复时不抢焦点 */
  noFocus?: boolean;
  /** 不创建 Terminal Editor 画面（后台会话） */
  noPresentation?: boolean;
  /** 会话所属工作区根；缺省则用侧栏当前选中的新建目标根 */
  cwd?: string;
}

type SessionHistoryAction = "fork" | "rewind";

type ClientMessage =
  | { type: "ready" }
  | { type: "new" }
  | { type: "customize" }
  | { type: "refresh" }
  | { type: "resume"; id: string }
  | { type: "set-new-session-cwd"; path: string }
  | { type: "detach"; id: string }
  | { type: "shutdown"; id: string }
  | { type: "delete"; id: string }
  | { type: "archive"; id: string; archived: boolean }
  | { type: "load-user-messages"; action: SessionHistoryAction; id: string; requestId: string }
  | { type: "session-history-action"; action: SessionHistoryAction; id: string; entryId?: string };

export const PI_VIEW_ID = "pi-for-vscode.sessionView";
const PI_CONTAINER_COMMAND = "workbench.view.extension.pi-for-vscode";

/**
 * VS Code 会把锁定分组写进布局，但 Terminal Editor（isTransient，且
 * TerminalEditorInput.canReopen() === false）重启后无法恢复标签，
 * 于是留下空的锁定分组。启动后清掉这些空组。
 */
export function closeEmptyEditorGroups(): void {
  const groups = vscode.window.tabGroups.all;
  if (groups.length <= 1) return;
  for (const group of groups) {
    if (group.tabs.length === 0) void vscode.window.tabGroups.close(group, true);
  }
}

export function scheduleCloseEmptyEditorGroups(): vscode.Disposable {
  closeEmptyEditorGroups();
  const timer = setTimeout(closeEmptyEditorGroups, 1500);
  return { dispose: () => clearTimeout(timer) };
}

const PI_VIEW_STATE_KEY = "pi-for-vscode.viewState";
const PI_NATIVE_DRAFT_FILE_ENV = "PI_VSCODE_DRAFT_FILE";
const SESSION_ACTION_DISABLED_MESSAGE = "会话空闲后才能使用此操作";
const DEFAULT_PI_COMMAND = "pi";
const CONFIG_SECTION = "pi-for-vscode";
let ptyPrepared = false;
/** 自动探测到的 pi 路径；用户显式配置 command 后不再使用 */
let resolvedPiCommand: string | undefined;

function currentWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    const activeFolder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
    if (activeFolder?.uri.fsPath) return activeFolder;
  }
  return vscode.workspace.workspaceFolders?.find((folder) => Boolean(folder.uri.fsPath));
}

function workspaceRoots(): WorkspaceRoot[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => Boolean(folder.uri.fsPath))
    .map((folder) => ({ name: folder.name, path: folder.uri.fsPath }));
}

export class PiViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private manager: PiSessionManager | undefined;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly memento: vscode.Memento,
    private readonly getIpcEnv: () => Record<string, string>,
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        if (this.disposed) return;
        const existed = Boolean(this.manager);
        this.createManager();
        if (!existed && this.view) this.manager?.attachView(this.view);
      }),
    );
  }

  async open(): Promise<void> {
    if (workspaceRoots().length === 0) {
      await vscode.window.showErrorMessage("请先打开一个工作区文件夹。");
      return;
    }

    await vscode.commands.executeCommand(PI_CONTAINER_COMMAND);
    this.view?.show();
    this.createManager();
    this.manager?.restoreOpenSessions();
  }

  async newSession(): Promise<void> {
    if (!this.manager) await this.open();
    this.manager?.startNewSession();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    if (this.disposed) return;
    this.view = webviewView;
    this.createManager();
    this.manager?.attachView(webviewView);
    webviewView.onDidDispose(() => {
      if (this.view !== webviewView) return;
      this.view = undefined;
      this.manager?.detachView(webviewView);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.manager?.dispose();
    this.manager = undefined;
    this.view = undefined;
    for (const disposable of this.disposables) disposable.dispose();
  }

  private createManager(): void {
    if (this.disposed || this.manager) return;
    if (workspaceRoots().length === 0) {
      if (this.view)
        this.view.webview.html = "<!doctype html><body>请先打开一个工作区文件夹。</body>";
      return;
    }

    this.manager = new PiSessionManager(this.extensionUri, this.memento, this.getIpcEnv);
  }
}

class PiSessionManager implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly viewDisposables: vscode.Disposable[] = [];
  private readonly sessions = new Map<string, RunningSession>();
  private readonly history = new Map<string, PiSession>();
  private readonly sessionStates = new Map<string, PiSessionState>();
  private readonly statusSequences = new Map<string, { sourceId: string; seq: number }>();
  private readonly historyWatchers = new Map<string, FSWatcher>();
  private readonly tabStates = new Map<string, { state: PiSessionState; changedAtMs: number }>();
  private readonly replacingProcesses = new Set<IPty>();
  private readonly sessionActions = new Set<string>();
  private readonly pendingStarts: Array<{
    id: string;
    sessionPath?: string;
    options?: StartSessionOptions;
  }> = [];
  private readonly statusBridge: PiStatusBridge;
  private viewState: PiViewState;
  private terminal: vscode.Terminal | undefined;
  private pseudoterminal: PiPseudoterminal | undefined;
  private presentedSession: RunningSession | undefined;
  private terminalEditorGroup: vscode.TabGroup | undefined;
  private terminalEditorViewColumn: vscode.ViewColumn | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private recoveringStart = false;
  private historyWatchSyncing = false;
  private statusBridgeReady = false;
  private view: vscode.WebviewView | undefined;
  private viewReady = false;
  private disposed = false;
  private newSessionCwd: string | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly memento: vscode.Memento,
    private readonly getIpcEnv: () => Record<string, string>,
  ) {
    this.viewState = normalizeViewState(this.memento.get(PI_VIEW_STATE_KEY));
    this.statusBridge = new PiStatusBridge((report) => this.handleStatusReport(report));
    this.newSessionCwd = coerceWorkspaceCwd(workspaceRoots(), currentWorkspaceFolder()?.uri.fsPath);
    vscode.workspace.onDidChangeConfiguration(
      (event) => {
        if (event.affectsConfiguration(`${CONFIG_SECTION}.terminal.closeBehavior`))
          this.postCloseBehavior();
      },
      undefined,
      this.disposables,
    );
    vscode.window.onDidChangeActiveTerminal(
      (terminal) => {
        const session = terminal ? this.sessionForTerminal(terminal) : undefined;
        if (session && terminal) {
          this.setFocusedSession(session.tabId);
          const group = vscode.window.tabGroups.activeTabGroup;
          if (group.activeTab?.input instanceof vscode.TabInputTerminal) {
            this.terminalEditorGroup = group;
            this.terminalEditorViewColumn = group.viewColumn;
            void vscode.commands.executeCommand("workbench.action.lockEditorGroup");
          }
        }
        this.postActiveSession(session?.tabId);
      },
      undefined,
      this.disposables,
    );
    vscode.window.onDidChangeActiveTextEditor(
      (editor) => {
        if (!editor || editor.document.uri.scheme !== "file") return;
        const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        if (!folder?.uri.fsPath) return;
        this.setNewSessionCwd(folder.uri.fsPath);
      },
      undefined,
      this.disposables,
    );
    vscode.workspace.onDidChangeWorkspaceFolders(
      () => {
        this.newSessionCwd = coerceWorkspaceCwd(workspaceRoots(), this.newSessionCwd);
        this.postWorkspaceFolders();
        void this.refreshHistory();
      },
      undefined,
      this.disposables,
    );
    void this.refreshHistory();
    void this.boot();
  }

  private async boot(): Promise<void> {
    const status = this.statusBridge.start().catch((error) => {
      void vscode.window.showWarningMessage(`会话状态不可用：${errorMessage(error)}`);
    });
    const detect = detectPiCommand().then((found) => {
      if (found) resolvedPiCommand = found;
    });
    await Promise.race([Promise.all([status, detect]), sleep(2000)]);
    if (this.disposed) return;
    this.statusBridgeReady = true;
    for (const pending of this.pendingStarts.splice(0)) {
      this.startSession(pending.id, pending.sessionPath, pending.options);
    }
  }

  attachView(view: vscode.WebviewView): void {
    if (this.disposed) return;
    this.clearViewDisposables();
    this.view = view;
    this.viewReady = false;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    this.viewDisposables.push(
      view.webview.onDidReceiveMessage((message: unknown) => void this.receive(message)),
    );
    view.webview.html = webviewHtml(view.webview, this.extensionUri);
  }

  detachView(view: vscode.WebviewView): void {
    if (this.view !== view) return;
    this.view = undefined;
    this.viewReady = false;
    this.clearViewDisposables();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const watcher of this.historyWatchers.values()) watcher.close();
    this.historyWatchers.clear();
    void this.statusBridge.dispose();
    if (this.presentedSession) this.closePresentation(this.presentedSession);
    for (const session of this.sessions.values()) {
      session.process.kill();
      session.replay.dispose();
    }
    this.sessions.clear();
    this.pendingStarts.length = 0;
    this.clearViewDisposables();
    for (const disposable of this.disposables) disposable.dispose();
  }

  private async receive(message: unknown): Promise<void> {
    if (!isClientMessage(message) || this.disposed) return;
    switch (message.type) {
      case "ready":
        this.viewReady = true;
        this.postHistory();
        this.postWorkspaceFolders();
        this.postCloseBehavior();
        this.postActiveSession(this.activeSession()?.tabId);
        break;
      case "new":
        this.startNewSession();
        break;
      case "customize":
        await vscode.commands.executeCommand("workbench.action.openSettings", CONFIG_SECTION);
        break;
      case "detach":
        this.detachSession(message.id);
        break;
      case "shutdown":
        this.shutdownSession(message.id);
        break;
      case "delete":
        await this.deleteSession(message.id);
        break;
      case "archive":
        this.archiveSession(message.id, message.archived);
        break;
      case "load-user-messages":
        await this.loadUserMessages(message.action, message.id, message.requestId);
        break;
      case "session-history-action":
        await this.runSessionHistoryAction(message.action, message.id, message.entryId);
        break;
      case "refresh":
        await this.refreshHistory();
        break;
      case "resume":
        this.resumeSession(message.id);
        break;
      case "set-new-session-cwd":
        this.setNewSessionCwd(message.path);
        break;
    }
  }

  private clearViewDisposables(): void {
    for (const disposable of this.viewDisposables.splice(0)) disposable.dispose();
  }

  startNewSession(): void {
    this.startSession(randomUUID());
  }

  /** 只恢复上次打开的会话，空列表不自动新建，避免 F5 启动就 spawn pty。 */
  restoreOpenSessions(): void {
    if (this.sessions.size > 0) return;
    const restored = this.viewState.openSessions;
    const focused = this.viewState.focusedSessionId;
    if (!restored.length) return;
    const visible = restored.find((record) => record.id === focused) ?? restored[0];
    for (const record of restored) {
      this.startSession(record.id, record.path, {
        cwd: record.cwd ?? this.history.get(record.id)?.cwd,
        noFocus: true,
        noPresentation: record.id !== visible.id,
      });
    }
    if (this.openSessionFor(visible.id)) {
      this.viewState = { ...this.viewState, focusedSessionId: visible.id };
      this.persistViewState();
    }
  }

  private resumeSession(id: string): void {
    const openSession = this.openSessionFor(id);
    if (openSession) {
      this.openPresentation(openSession, false);
      return;
    }
    const session = this.history.get(id);
    if (session) this.startSession(id, session.path, { cwd: session.cwd });
  }

  /** Closing a tab leaves Pi running; the session can be reopened from the list. */
  private detachSession(tabId: string): void {
    const session = this.sessions.get(tabId);
    if (!session || !session.attached) return;
    session.attached = false;
    this.closePresentation(session);
    this.persistViewState();
    this.postHistory();
  }

  private shutdownSession(tabId: string): void {
    const session = this.sessions.get(tabId);
    if (!session) return;
    this.sessions.delete(tabId);
    this.statusSequences.delete(tabId);
    this.sessionStates.set(session.sessionId, "inactive");
    this.noteTabState(tabId, "inactive");
    this.closePresentation(session);
    session.process.kill();
    session.replay.dispose();
    this.persistViewState();
    this.postHistory();
  }

  /** Deleting is keyed by session id, not tab id: a session can be deleted without a live tab. */
  private async deleteSession(sessionId: string): Promise<void> {
    const title =
      this.history.get(sessionId)?.title ??
      this.openSessionFor(sessionId)?.title ??
      NEW_SESSION_TITLE;
    const choice = await vscode.window.showWarningMessage(
      `删除会话「${title}」？`,
      { modal: true, detail: "将停止 Pi，并从磁盘删除该会话文件。此操作不可撤销。" },
      "删除",
    );
    if (choice !== "删除" || this.disposed) return;

    // ponytail: deletes right after the kill; wait for process exit only if Pi is seen re-creating the transcript.
    const open = this.openSessionFor(sessionId);
    if (open) this.shutdownSession(open.tabId);
    const path = this.history.get(sessionId)?.path ?? open?.path;
    try {
      if (path) await deleteSessionFiles(path);
    } catch (error) {
      // The next refresh restores whatever survived on disk.
      void vscode.window.showErrorMessage(`无法删除「${title}」：${errorMessage(error)}`);
      return;
    }
    if (this.disposed) return;
    this.history.delete(sessionId);
    this.sessionStates.delete(sessionId);
    // The archive list is the only view state keyed by session id; the rest is rebuilt from live tabs.
    this.viewState = setArchived(this.viewState, sessionId, false);
    this.persistViewState();
    this.postHistory();
  }

  // Archiving files the session under Archive and closes its native terminal; Pi keeps running.
  private archiveSession(sessionId: string, archived: boolean): void {
    if (archived) {
      const open = this.openSessionFor(sessionId);
      if (open?.attached) this.detachSession(open.tabId);
    }
    this.viewState = setArchived(this.viewState, sessionId, archived);
    this.persistViewState();
    this.postHistory();
  }

  private async loadUserMessages(
    action: SessionHistoryAction,
    sessionId: string,
    requestId: string,
  ): Promise<void> {
    try {
      const source = this.sessionActionSource(sessionId);
      this.assertSessionActionAvailable(source.open);
      const messages = await listSessionUserMessages(source.path, source.open?.leafId);
      this.post({ type: "user-messages", action, sessionId, requestId, messages });
    } catch (error) {
      this.post({
        type: "user-messages",
        action,
        sessionId,
        requestId,
        error: errorMessage(error),
        messages: [],
      });
    }
  }

  private async runSessionHistoryAction(
    action: SessionHistoryAction,
    sessionId: string,
    entryId?: string,
  ): Promise<void> {
    if (this.sessionActions.has(sessionId)) return;
    this.sessionActions.add(sessionId);
    try {
      if (action === "fork") await this.forkSession(sessionId, entryId);
      else await this.rewindSessionToMessage(sessionId, entryId!);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `无法${action === "fork" ? "分叉" : "回退"}会话：${errorMessage(error)}`,
      );
    } finally {
      this.sessionActions.delete(sessionId);
    }
  }

  private async forkSession(sessionId: string, entryId?: string): Promise<void> {
    const source = this.sessionActionSource(sessionId);
    this.assertSessionActionAvailable(source.open);
    let forked: Awaited<ReturnType<typeof createForkedSession>> | undefined;
    let draftFile: string | undefined;
    try {
      forked = await createForkedSession(source.path, entryId, source.title, source.open?.leafId);
      if (forked.draft) draftFile = await createNativeDraftFile(forked.draft);
      await this.refreshHistory();
      const failure = this.startSession(forked.id, forked.path, {
        cwd: source.cwd,
        nativeDraftFile: draftFile,
        reportError: false,
      });
      if (failure) throw new Error(failure);
    } catch (error) {
      if (draftFile) await removeNativeDraftFile(draftFile).catch(() => undefined);
      if (forked) await deleteSessionFiles(forked.path).catch(() => undefined);
      await this.refreshHistory();
      throw error;
    }
  }

  private async rewindSessionToMessage(sessionId: string, entryId: string): Promise<void> {
    let source = this.sessionActionSource(sessionId);
    this.assertSessionActionAvailable(source.open);
    let prepared = await prepareRewindSession(
      source.path,
      entryId,
      source.title,
      source.open?.leafId,
    );
    const snapshot = await resolveSessionSnapshot(source.path, entryId);
    let revertCode = false;
    if (snapshot && (await worktreeDiffersFromSnapshot(source.cwd, snapshot))) {
      const choice = await vscode.window.showWarningMessage(
        "要从更早的消息重新提交吗？",
        {
          modal: true,
          detail: "回退会清掉该消息之后的对话，并可选择把工作区文件还原到该消息之前。",
        },
        "不还原代码",
        "还原代码",
      );
      if (!choice || this.disposed) return;
      revertCode = choice === "还原代码";
    }

    // The user can submit from the terminal while the confirmation is open. Re-read
    // and re-check immediately before stopping or rewriting the session.
    source = this.sessionActionSource(sessionId);
    this.assertSessionActionAvailable(source.open);
    prepared = await prepareRewindSession(source.path, entryId, source.title, source.open?.leafId);
    const originalContents = await fs.readFile(source.path, "utf8");
    const draftFile = await createNativeDraftFile(prepared.draft);
    const tabId = source.open?.tabId ?? sessionId;
    let stopped = false;
    let rewritten = false;
    try {
      if (source.open) {
        await this.stopSessionForReplacement(source.open);
        stopped = true;
      }
      if (revertCode && snapshot) await restoreWorktreeSnapshot(source.cwd, snapshot);
      await rewriteSessionFile(source.path, prepared.contents);
      rewritten = true;
      await this.refreshHistory();
      const failure = this.startSession(tabId, source.path, {
        cwd: source.cwd,
        nativeDraftFile: draftFile,
        reportError: false,
      });
      if (failure) throw new Error(failure);
    } catch (error) {
      await removeNativeDraftFile(draftFile).catch(() => undefined);
      if (rewritten) await rewriteSessionFile(source.path, originalContents).catch(() => undefined);
      const current = this.sessions.get(tabId);
      if (stopped && (!current || current.process === source.open?.process)) {
        this.startSession(tabId, source.path, { cwd: source.cwd, reportError: false });
      } else if (!stopped && current?.process === source.open?.process) {
        this.sessionStates.set(sessionId, "idle");
        this.postHistory();
      }
      await this.refreshHistory();
      throw error;
    }
  }

  private sessionActionSource(sessionId: string): {
    path: string;
    title: string;
    cwd: string;
    open: RunningSession | undefined;
  } {
    const open = this.openSessionFor(sessionId);
    const saved = this.history.get(sessionId);
    const path = saved?.path ?? open?.path;
    const cwd = saved?.cwd ?? open?.cwd;
    if (!path) throw new Error("请先发送一条消息再使用此操作。");
    if (!cwd) throw new Error("无法确定该会话的工作区根目录。");
    return { path, title: saved?.title ?? open?.title ?? NEW_SESSION_TITLE, cwd, open };
  }

  private assertSessionActionAvailable(open: RunningSession | undefined): void {
    if (!open || this.sessionStates.get(open.sessionId) === "idle") return;
    throw new Error(SESSION_ACTION_DISABLED_MESSAGE);
  }

  private async stopSessionForReplacement(session: RunningSession): Promise<void> {
    const process = session.process;
    this.replacingProcesses.add(process);
    this.sessionStates.set(session.sessionId, "starting");
    this.postHistory();
    await new Promise<void>((resolvePromise, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let listener: { dispose(): void } | undefined;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        listener?.dispose();
        this.replacingProcesses.delete(process);
        if (error) reject(error);
        else resolvePromise();
      };
      listener = process.onExit(() => finish());
      timer = setTimeout(() => finish(new Error("停止 Pi 会话超时。")), 5_000);
      try {
        process.kill();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.closePresentation(session);
    session.replay.dispose();
  }

  private setFocusedSession(tabId: string): void {
    const session = this.sessions.get(tabId);
    if (!session) return;
    if (session.attached && this.viewState.focusedSessionId === session.sessionId) return;
    session.attached = true;
    this.viewState = { ...this.viewState, focusedSessionId: session.sessionId };
    this.persistViewState();
    this.postActiveSession(tabId);
  }

  private persistViewState(): void {
    if (this.disposed) return;
    const openSessions = [...this.sessions.values()]
      .filter((session) => session.attached)
      .map((session) => ({
        id: session.sessionId,
        cwd: session.cwd,
        ...(session.path ? { path: session.path } : {}),
      }));
    this.viewState = normalizeViewState({ ...this.viewState, openSessions });
    void this.memento.update(PI_VIEW_STATE_KEY, this.viewState);
  }

  private noteTabState(tabId: string, state: PiSessionState): void {
    if (this.tabStates.get(tabId)?.state === state) return;
    this.tabStates.set(tabId, { state, changedAtMs: Date.now() });
  }

  private startSession(
    id: string,
    sessionPath?: string,
    options: StartSessionOptions = {},
  ): string | undefined {
    const command = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<string>("command", DEFAULT_PI_COMMAND)
      .trim();
    if (!command) {
      const failure = "请在设置里指定 pi-for-vscode.command 为 pi 可执行文件。";
      if (options.reportError !== false) void vscode.window.showErrorMessage(failure);
      return failure;
    }

    const cwd = options.cwd ?? coerceWorkspaceCwd(workspaceRoots(), this.newSessionCwd);
    if (!cwd) {
      const failure = "请先打开一个工作区文件夹。";
      if (options.reportError !== false) void vscode.window.showErrorMessage(failure);
      return failure;
    }

    let spawnedProcess: IPty | undefined;
    let replay: TerminalReplay | undefined;
    try {
      preparePty();
      const tabId = id;
      const cols = 80;
      const rows = 24;
      const args = sessionPath ? ["--session", sessionPath] : ["--session-id", id];
      if (this.statusBridge.isListening)
        args.push("--extension", piStatusExtensionPath(this.extensionUri));
      const draftEnvironment = options.nativeDraftFile
        ? { [PI_NATIVE_DRAFT_FILE_ENV]: options.nativeDraftFile }
        : {};
      const file = effectivePiCommand(command);
      const spawn = process.platform === "win32" ? win32Spawn(file, args) : { file, args };
      const scrollback = clamp(
        vscode.workspace.getConfiguration("terminal.integrated").get<number>("scrollback", 1000),
        0,
        100_000,
      );
      replay = new TerminalReplay(cols, rows, scrollback);
      const child = getPty().spawn(spawn.file, spawn.args, {
        cwd,
        name: "xterm-256color",
        cols,
        rows,
        env: {
          ...terminalEnvironment(),
          ...this.getIpcEnv(),
          ...this.statusBridge.environmentFor(tabId),
          ...draftEnvironment,
        },
      });
      spawnedProcess = child;
      const title = this.titleForSession(id);
      const session: RunningSession = {
        tabId,
        sessionId: id,
        startedAtMs: Date.now(),
        title,
        cwd,
        path: sessionPath,
        attached: options.noPresentation !== true,
        process: child,
        replay,
        cols,
        rows,
      };
      this.sessions.set(tabId, session);
      this.statusSequences.delete(tabId);
      this.sessionStates.set(id, "starting");
      this.noteTabState(tabId, "starting");
      child.onData((data) => {
        const sequence = replay!.write(data);
        if (this.presentedSession === session) this.pseudoterminal?.write(data, sequence);
        this.refreshSoon();
      });
      child.onExit(({ exitCode }) => this.handleExit(tabId, child, exitCode));
      if (options.noPresentation !== true) this.openPresentation(session, options.noFocus === true);
      this.persistViewState();
      this.postHistory();
      this.refreshSoon();
      return undefined;
    } catch (error) {
      this.sessions.delete(id);
      this.sessionStates.delete(id);
      this.statusSequences.delete(id);
      spawnedProcess?.kill();
      replay?.dispose();
      const failure = `无法启动 pi： ${errorMessage(error)}`;
      if (options.reportError !== false) {
        // Auto-detect pi (PATH, npm global dir) and restart; only prompt when that fails.
        void this.recoverStart(id, sessionPath, options, failure);
      }
      return failure;
    }
  }

  private openPresentation(session: RunningSession, preserveFocus: boolean): void {
    if (this.disposed || this.sessions.get(session.tabId) !== session) return;
    if (this.presentedSession && this.presentedSession !== session)
      this.presentedSession.attached = false;
    this.presentedSession = session;
    session.attached = true;

    let terminal = this.terminal;
    let pseudoterminal = this.pseudoterminal;
    if (terminal && pseudoterminal) {
      pseudoterminal.switchBackend(this.terminalBackend(session, pseudoterminal), session.title);
    } else {
      const existingGroups = new Set(vscode.window.tabGroups.all);
      const viewColumn =
        this.terminalEditorViewColumn ??
        this.reusableEmptyEditorGroup() ??
        vscode.ViewColumn.Beside;
      pseudoterminal = new PiPseudoterminal({
        replay: () => session.replay.snapshot(),
        input: (data) => {
          if (this.presentedSession === session && data.length <= 1024 * 1024)
            session.process.write(data);
        },
        resize: (cols, rows) => this.resizeSession(session, cols, rows),
        close: () => this.handlePresentationClosed(pseudoterminal!),
      });
      terminal = vscode.window.createTerminal({
        name: session.title,
        pty: pseudoterminal,
        location: {
          viewColumn,
          preserveFocus,
        },
        iconPath: {
          light: vscode.Uri.joinPath(this.extensionUri, "media", "pi.svg"),
          dark: vscode.Uri.joinPath(this.extensionUri, "media", "pi-dark.svg"),
        },
        isTransient: true,
      });
      this.pseudoterminal = pseudoterminal;
      this.terminal = terminal;
      this.rememberTerminalEditorGroup(terminal, true, existingGroups, viewColumn);
    }
    terminal.show(preserveFocus);
    if (!preserveFocus) {
      this.setFocusedSession(session.tabId);
    }
    this.persistViewState();
    this.postHistory();
  }

  private reusableEmptyEditorGroup(): vscode.ViewColumn | undefined {
    const activeColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;
    const emptyGroups = vscode.window.tabGroups.all.filter((group) => group.tabs.length === 0);
    return (
      emptyGroups
        .filter((group) => group.viewColumn >= activeColumn)
        .sort((left, right) => left.viewColumn - right.viewColumn)[0] ??
      emptyGroups.sort((left, right) => right.viewColumn - left.viewColumn)[0]
    )?.viewColumn;
  }

  private terminalBackend(session: RunningSession, pseudoterminal: PiPseudoterminal) {
    return {
      replay: () => session.replay.snapshot(),
      input: (data: string) => {
        if (this.presentedSession === session && data.length <= 1024 * 1024)
          session.process.write(data);
      },
      resize: (cols: number, rows: number) => this.resizeSession(session, cols, rows),
      close: () => this.handlePresentationClosed(pseudoterminal),
    };
  }

  private rememberTerminalEditorGroup(
    terminal: vscode.Terminal,
    lock: boolean,
    existingGroups: ReadonlySet<vscode.TabGroup>,
    expectedColumn: vscode.ViewColumn,
  ): void {
    let subscription: vscode.Disposable | undefined;
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      subscription?.dispose();
      if (timer) clearTimeout(timer);
    };
    const locate = () => {
      if (this.disposed || this.terminal !== terminal) return finish();
      const active = vscode.window.tabGroups.activeTabGroup;
      const group =
        vscode.window.activeTerminal === terminal &&
        active.activeTab?.input instanceof vscode.TabInputTerminal
          ? active
          : vscode.window.tabGroups.all.find(
              (candidate) =>
                candidate.activeTab?.input instanceof vscode.TabInputTerminal &&
                (!existingGroups.has(candidate) || candidate.viewColumn === expectedColumn),
            );
      if (!group) return;
      this.terminalEditorGroup = group;
      this.terminalEditorViewColumn = group.viewColumn;
      finish();
      // The command targets the active group. Background terminals rely on
      // VS Code's built-in terminal-editor auto-lock instead of stealing focus.
      if (lock && group.isActive)
        void vscode.commands.executeCommand("workbench.action.lockEditorGroup");
    };
    subscription = vscode.window.tabGroups.onDidChangeTabs(locate);
    timer = setTimeout(finish, 2_000);
    queueMicrotask(locate);
  }

  private handlePresentationClosed(pseudoterminal: PiPseudoterminal): void {
    if (this.pseudoterminal !== pseudoterminal) return;
    const session = this.presentedSession;
    this.pseudoterminal = undefined;
    this.terminal = undefined;
    this.presentedSession = undefined;
    this.closeEmptyTerminalEditorGroup();
    if (!session) return;
    session.attached = false;
    if (this.disposed || this.sessions.get(session.tabId) !== session) return;
    if (this.replacingProcesses.has(session.process)) return;
    const stop =
      vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get<string>("terminal.closeBehavior", "detach") === "stop";
    if (stop) this.shutdownSession(session.tabId);
    else {
      this.persistViewState();
      this.postHistory();
      this.postActiveSession(this.activeSession()?.tabId);
    }
  }

  private closePresentation(session: RunningSession, exitCode?: number): void {
    if (this.presentedSession !== session) return;
    const terminal = this.terminal;
    const pseudoterminal = this.pseudoterminal;
    this.presentedSession = undefined;
    this.terminal = undefined;
    this.pseudoterminal = undefined;
    pseudoterminal?.end(exitCode);
    terminal?.dispose();
    this.closeEmptyTerminalEditorGroup();
  }

  private closeEmptyTerminalEditorGroup(): void {
    const group = this.terminalEditorGroup;
    this.terminalEditorGroup = undefined;
    this.terminalEditorViewColumn = undefined;
    if (!group) return;
    let subscription: vscode.Disposable | undefined;
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      subscription?.dispose();
      if (timer) clearTimeout(timer);
    };
    const closeIfEmpty = () => {
      if (!vscode.window.tabGroups.all.includes(group)) return finish();
      if (group.tabs.length !== 0) return;
      finish();
      void vscode.window.tabGroups.close(group, true);
    };
    subscription = vscode.window.tabGroups.onDidChangeTabs(closeIfEmpty);
    timer = setTimeout(finish, 2_000);
    queueMicrotask(closeIfEmpty);
  }

  private resizeSession(session: RunningSession, cols: number, rows: number): void {
    if (this.sessions.get(session.tabId) !== session) return;
    const nextCols = clamp(Math.round(cols), 2, 1000);
    const nextRows = clamp(Math.round(rows), 1, 500);
    if (session.cols === nextCols && session.rows === nextRows) return;
    session.cols = nextCols;
    session.rows = nextRows;
    session.replay.resize(nextCols, nextRows);
    try {
      session.process.resize(nextCols, nextRows);
    } catch {
      // The process may have exited between VS Code's resize event and this write.
    }
  }

  /**
   * A session failed to spawn. Try to locate pi automatically; if that fails, ask the user
   * for its executable (browse or type) and restart with it saved to piAgent.command.
   */
  private async recoverStart(
    id: string,
    sessionPath: string | undefined,
    options: StartSessionOptions,
    failure: string,
  ): Promise<void> {
    if (this.disposed || this.recoveringStart) return;
    this.recoveringStart = true;
    try {
      const configured = vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get<string>("command", DEFAULT_PI_COMMAND)
        .trim();
      // Only auto-detect the default bare name; an explicit path is the user's own choice.
      if (configured === DEFAULT_PI_COMMAND && !resolvedPiCommand) {
        const found = await detectPiCommand();
        if (found && !this.disposed) {
          resolvedPiCommand = found;
          const retry = this.startSession(id, sessionPath, { ...options, reportError: false });
          if (!retry) return;
          failure = retry;
        }
      }
      await this.promptForPiLocation(id, sessionPath, options, failure);
    } finally {
      this.recoveringStart = false;
    }
  }

  private async promptForPiLocation(
    id: string,
    sessionPath: string | undefined,
    options: StartSessionOptions,
    failure: string,
  ): Promise<void> {
    if (this.disposed) return;
    const action = await vscode.window.showErrorMessage(
      `${failure}\n请安装 pi（npm install -g @earendil-works/pi-coding-agent；Windows 需要 Git Bash），或指定已有可执行文件。`,
      "定位 pi…",
      "安装说明",
    );
    if (!action || this.disposed) return;
    if (action === "安装说明") {
      await vscode.env.openExternal(vscode.Uri.parse("https://pi.dev"));
      return;
    }

    const browse = "浏览选择 pi 可执行文件";
    const manual = "手动输入路径";
    const method = await vscode.window.showQuickPick(
      [
        { label: browse, detail: "打开文件选择器" },
        { label: manual, detail: "输入 pi 的绝对路径" },
      ],
      { placeHolder: "如何提供 pi 可执行文件？" },
    );
    let chosen: string | undefined;
    if (method?.label === browse) {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectMany: false,
        openLabel: "选择 pi",
        title: "选择 pi 可执行文件",
      });
      chosen = picked?.[0]?.fsPath;
    } else if (method?.label === manual) {
      chosen = await vscode.window.showInputBox({
        prompt: "pi 可执行文件的绝对路径",
        placeHolder:
          process.platform === "win32"
            ? "C:\\Users\\you\\AppData\\Roaming\\npm\\pi.cmd"
            : "/usr/local/bin/pi",
        validateInput: (value) => {
          const path = value.trim();
          if (!path) return "请输入路径";
          return existsSync(path) ? undefined : "找不到该文件";
        },
      });
    }
    const path = chosen?.trim();
    if (!path || this.disposed) return;
    await vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .update("command", path, vscode.ConfigurationTarget.Global);
    resolvedPiCommand = undefined;
    const retry = this.startSession(id, sessionPath, { ...options, reportError: false });
    if (retry) void vscode.window.showErrorMessage(retry);
  }

  private handleExit(tabId: string, process: IPty, exitCode: number): void {
    if (this.replacingProcesses.has(process)) return;
    const session = this.sessions.get(tabId);
    if (!session || this.disposed || session.process !== process) return;
    this.sessions.delete(tabId);
    this.statusSequences.delete(tabId);
    this.sessionStates.set(session.sessionId, "inactive");
    this.noteTabState(tabId, "inactive");
    session.attached = false;
    this.closePresentation(session, exitCode);
    session.replay.dispose();
    this.persistViewState();
    this.postHistory();
    if (exitCode !== 0) {
      if (Date.now() - session.startedAtMs < 4000) {
        void this.recoverStart(
          session.sessionId,
          session.path,
          { cwd: session.cwd },
          `pi 已退出，退出码 ${exitCode}`,
        );
      } else {
        void vscode.window.showWarningMessage(`pi 已退出，退出码 ${exitCode}`);
      }
    }
    this.refreshSoon();
  }

  private async refreshHistory(): Promise<void> {
    const sessions = await listWorkspaceSessions(workspaceRoots().map((folder) => folder.path));
    if (this.disposed) return;
    this.history.clear();
    for (const session of sessions) this.history.set(session.id, session);
    this.syncSessionTitles();
    this.postHistory();
    void this.syncHistoryWatchers();
  }

  private handleStatusReport(report: PiStatusReport): void {
    const session = this.sessions.get(report.tabId);
    if (!session) return;
    const previous = this.statusSequences.get(report.tabId);
    if (previous?.sourceId === report.sourceId && previous.seq >= report.seq) return;
    this.statusSequences.set(report.tabId, { sourceId: report.sourceId, seq: report.seq });
    const previousState = this.sessionStates.get(session.sessionId);
    if (session.sessionId !== report.sessionId) {
      this.sessionStates.set(session.sessionId, "inactive");
      session.sessionId = report.sessionId;
      session.startedAtMs = Date.now();
      session.title = this.titleForSession(report.sessionId);
      this.postSessionMeta(session);
      this.persistViewState();
    }
    if (report.sessionPath && report.sessionPath !== session.path) {
      session.path = report.sessionPath;
      this.persistViewState();
    }
    session.leafId = report.leafId;
    this.sessionStates.set(report.sessionId, report.state);
    this.noteTabState(report.tabId, report.state);
    if (becameIdle(previousState, report.state)) this.post({ type: "attention" });
    this.postHistory();
  }

  private openSessionFor(sessionId: string): RunningSession | undefined {
    return [...this.sessions.values()].find((session) => session.sessionId === sessionId);
  }

  private titleForSession(sessionId: string): string {
    return this.history.get(sessionId)?.title ?? NEW_SESSION_TITLE;
  }

  private syncSessionTitles(): void {
    for (const session of this.sessions.values())
      this.setSessionTitle(session, this.titleForSession(session.sessionId));
  }

  private setSessionTitle(session: RunningSession, title: string): void {
    if (session.title === title) return;
    session.title = title;
    if (this.presentedSession === session) this.pseudoterminal?.rename(title);
  }

  private postSessionMeta(session: RunningSession): void {
    if (this.presentedSession === session) this.pseudoterminal?.rename(session.title);
  }

  private async syncHistoryWatchers(): Promise<void> {
    if (this.disposed || this.historyWatchSyncing) return;
    this.historyWatchSyncing = true;
    try {
      const directories = new Set<string>();
      for (const folder of workspaceRoots()) {
        for (const directory of await sessionDirectoriesForWorkspace(folder.path)) {
          directories.add(directory);
        }
      }
      if (this.disposed) return;
      for (const [directory, watcher] of this.historyWatchers) {
        if (directories.has(directory)) continue;
        watcher.close();
        this.historyWatchers.delete(directory);
      }
      for (const directory of directories) {
        if (this.historyWatchers.has(directory)) continue;
        try {
          const watcher = watch(directory, { persistent: false }, () => this.refreshSoon());
          watcher.on("error", () => {
            if (this.historyWatchers.get(directory) !== watcher) return;
            watcher.close();
            this.historyWatchers.delete(directory);
            this.refreshSoon();
          });
          this.historyWatchers.set(directory, watcher);
        } catch {
          // Pi creates a workspace session directory on startup; the next refresh retries this watch.
        }
      }
    } finally {
      this.historyWatchSyncing = false;
    }
  }

  private postHistory(): void {
    const archived = new Set(this.viewState.archivedSessionIds);
    const folders = workspaceRoots();
    const sessions = [...this.history.values()].map((saved) => {
      const openSession = this.openSessionFor(saved.id);
      const cwd = openSession?.cwd ?? saved.cwd;
      return {
        id: saved.id,
        title: saved.title,
        createdAtMs: saved.createdAtMs,
        updatedAtMs: saved.mtimeMs,
        archived: archived.has(saved.id),
        tabId: openSession?.tabId,
        attached: openSession?.attached === true,
        state: this.sessionStates.get(saved.id) ?? (openSession ? "starting" : "inactive"),
        rootName: rootNameForCwd(folders, cwd),
      };
    });
    for (const session of this.sessions.values()) {
      if (this.history.has(session.sessionId)) continue;
      sessions.push({
        id: session.sessionId,
        title: session.title,
        createdAtMs: session.startedAtMs,
        updatedAtMs: session.startedAtMs,
        archived: archived.has(session.sessionId),
        tabId: session.tabId,
        attached: session.attached,
        state: this.sessionStates.get(session.sessionId) ?? "starting",
        rootName: rootNameForCwd(folders, session.cwd),
      });
    }
    sessions.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    this.post({ type: "history", sessions });
  }

  private refreshSoon(): void {
    if (this.disposed || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refreshHistory();
    }, 500);
  }

  private postCloseBehavior(): void {
    const stop =
      vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get<string>("terminal.closeBehavior", "detach") === "stop";
    this.post({ type: "close-behavior", stop });
  }

  private post(message: object): void {
    if (this.disposed || !this.viewReady || !this.view) return;
    void this.view.webview.postMessage(message);
  }

  private sessionForTerminal(terminal: vscode.Terminal): RunningSession | undefined {
    return this.terminal === terminal ? this.presentedSession : undefined;
  }

  private activeSession(): RunningSession | undefined {
    const terminal = vscode.window.activeTerminal;
    return terminal ? this.sessionForTerminal(terminal) : undefined;
  }

  private postActiveSession(tabId: string | undefined): void {
    this.post({ type: "active-session", ...(tabId ? { tabId } : {}) });
  }

  private setNewSessionCwd(path: string): void {
    const next = coerceWorkspaceCwd(workspaceRoots(), path);
    if (!next || next === this.newSessionCwd) {
      if (next) this.postWorkspaceFolders();
      return;
    }
    this.newSessionCwd = next;
    this.postWorkspaceFolders();
  }

  private postWorkspaceFolders(): void {
    const folders = workspaceRoots();
    this.newSessionCwd = coerceWorkspaceCwd(folders, this.newSessionCwd);
    this.post({
      type: "workspace-folders",
      folders,
      selected: this.newSessionCwd,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function preparePty(): void {
  if (ptyPrepared || process.platform === "win32") return;
  ptyPrepared = true;
  const packageDir = dirname(require.resolve("node-pty/package.json"));
  for (const helper of [
    join(packageDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    join(packageDir, "build", "Release", "spawn-helper"),
  ]) {
    try {
      chmodSync(helper, 0o755);
    } catch {
      // A source or Windows install may not have this helper.
    }
  }
}

function piStatusExtensionPath(extensionUri: vscode.Uri): string {
  return vscode.Uri.joinPath(extensionUri, "resources", "pi-vscode-status.ts").fsPath;
}

function terminalEnvironment(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  return { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" };
}

/** An explicit piAgent.command wins; the auto-detected path only fills in the default. */
function effectivePiCommand(configured: string): string {
  return configured === DEFAULT_PI_COMMAND ? (resolvedPiCommand ?? configured) : configured;
}

async function detectPiCommand(): Promise<string | undefined> {
  return process.platform === "win32" ? detectPiCommandWindows() : detectPiCommandUnix();
}

async function detectPiCommandWindows(): Promise<string | undefined> {
  const where = await runCapture("cmd.exe", ["/d", "/s", "/c", "where pi"]);
  for (const line of where.split(/\r?\n/)) {
    const hit = line.trim();
    if (hit && existsSync(hit)) return hit;
  }
  // npm's global dir may be missing from a GUI-launched VS Code PATH (nvm, fnm, custom prefix).
  const appData = process.env.APPDATA;
  const npmShim = appData ? join(appData, "npm", "pi.cmd") : undefined;
  return npmShim && existsSync(npmShim) ? npmShim : undefined;
}

async function detectPiCommandUnix(): Promise<string | undefined> {
  const which = await runCapture("which", ["pi"]);
  for (const line of which.split("\n")) {
    const hit = line.trim();
    if (hit && existsSync(hit)) return hit;
  }
  // GUI-launched VS Code may miss shell-profile PATH entries (Homebrew, custom npm prefix).
  for (const dir of [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".local", "bin"),
    join(homedir(), ".bun", "bin"),
  ]) {
    const candidate = join(dir, "pi");
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function runCapture(file: string, args: string[], timeoutMs = 5_000): Promise<string> {
  return new Promise((resolvePromise) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      resolvePromise(error ? "" : stdout);
    });
  });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isClientMessage(value: unknown): value is ClientMessage {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const message = value as Record<string, unknown>;
  if (typeof message.type !== "string") return false;
  if (
    message.type === "ready" ||
    message.type === "refresh" ||
    message.type === "new" ||
    message.type === "customize"
  ) {
    return true;
  }
  if (message.type === "archive")
    return typeof message.id === "string" && typeof message.archived === "boolean";
  if (message.type === "load-user-messages") {
    return (
      isSessionHistoryAction(message.action) &&
      nonEmptyBoundedString(message.id, 512) &&
      nonEmptyBoundedString(message.requestId, 512)
    );
  }
  if (message.type === "session-history-action") {
    return (
      isSessionHistoryAction(message.action) &&
      nonEmptyBoundedString(message.id, 512) &&
      (message.entryId === undefined || nonEmptyBoundedString(message.entryId, 512)) &&
      (message.action !== "rewind" || nonEmptyBoundedString(message.entryId, 512))
    );
  }
  if (message.type === "detach" || message.type === "shutdown" || message.type === "delete") {
    return typeof message.id === "string";
  }
  if (message.type === "set-new-session-cwd") return nonEmptyBoundedString(message.path, 4096);
  return message.type === "resume" && typeof message.id === "string";
}

function isSessionHistoryAction(value: unknown): value is SessionHistoryAction {
  return value === "fork" || value === "rewind";
}

function nonEmptyBoundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength;
}

function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const uri = (...segments: string[]) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...segments));
  const nonce = randomUUID();
  return `<!doctype html>
<html lang="zh-CN">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<link rel="stylesheet" href="${uri("media", "main.css")}">
	<title>pi 会话</title>
</head>
<body>
	<div id="app">
		<main id="sidebar" aria-label="pi 会话">
			<div id="sidebar-header">
				<button id="customize" class="icon-button" type="button" title="打开设置" aria-label="打开设置"></button>
				<button id="refresh" class="icon-button" type="button" title="刷新会话" aria-label="刷新会话"></button>
			</div>
			<div id="search-field">
				<span class="search-icon" aria-hidden="true"></span>
				<input id="search" type="text" placeholder="搜索会话…" aria-label="搜索会话" autocomplete="off" spellcheck="false">
			</div>
			<nav id="sidebar-actions" aria-label="会话操作">
				<div class="new-session-row">
					<button id="new-session" class="sidebar-action" type="button">
						<span class="action-label">新建会话</span>
					</button>
					<select id="new-session-root" hidden aria-label="新建会话的工作区根目录"></select>
				</div>
			</nav>
			<div id="session-list"></div>
		</main>
	</div>
	<div id="menu" role="menu" hidden></div>
	<div id="message-dialog" class="dialog-scrim" hidden>
		<section class="message-dialog-card" role="dialog" aria-modal="true" aria-labelledby="message-dialog-title" aria-describedby="message-dialog-description">
			<header class="message-dialog-header">
				<h2 id="message-dialog-title"></h2>
				<p id="message-dialog-description"></p>
			</header>
			<div id="message-dialog-list" class="message-dialog-list" role="radiogroup" aria-label="用户消息"></div>
			<footer class="message-dialog-footer">
				<button id="message-dialog-cancel" class="dialog-button" type="button">取消</button>
				<button id="message-dialog-submit" class="dialog-button primary" type="button" disabled></button>
			</footer>
		</section>
	</div>
	<script nonce="${nonce}" src="${uri("media", "session-view.js")}"></script>
	<script nonce="${nonce}" src="${uri("media", "main.js")}"></script>
</body>
</html>`;
}
