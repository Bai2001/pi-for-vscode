// VSCode 宿主侧：named pipe 服务，把 pi 的浏览器工具请求转到 vscode.lm.invokeTool。
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { chmod } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import {
  adaptArgs,
  encodeMessage,
  ENV_IPC,
  ENV_TOKEN,
  extractLines,
  isIdeMethod,
  mapToolName,
  parseRequest,
  timeoutForTool,
  type BrowserIpcImage,
  type BrowserIpcResponse,
} from "./browser-protocol.js";
import { getIdeSnapshot, ideKeyFromMethod } from "./ide-store.js";

export interface BrowserIpcHandle {
  readonly env: Record<string, string>;
  dispose(): void;
}

const AUTO_APPROVE_ASKED = "browser.autoApprovePrompted";
const ENABLE_TOOLS_ASKED = "browser.enableChatToolsPrompted";

function pipePath(id: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\pi-for-vscode-browser-${id}`;
  }
  return join(tmpdir(), `pi-for-vscode-browser-${id}.sock`);
}

function newToken(): string {
  return randomBytes(24).toString("base64url");
}

function builtinToolNames(): Set<string> {
  return new Set(vscode.lm.tools.map((t) => t.name));
}

function inputSchemaOf(name: string): unknown {
  return vscode.lm.tools.find((t) => t.name === name)?.inputSchema;
}

function isCancelled(err: unknown): boolean {
  if (err instanceof vscode.CancellationError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /cancel/i.test(msg);
}

function toImage(part: vscode.LanguageModelDataPart): BrowserIpcImage | undefined {
  if (!part.mimeType.startsWith("image/")) return undefined;
  return {
    mimeType: part.mimeType,
    data: Buffer.from(part.data).toString("base64"),
  };
}

function convertResult(result: vscode.LanguageModelToolResult): {
  text: string;
  image?: BrowserIpcImage;
} {
  const texts: string[] = [];
  let image: BrowserIpcImage | undefined;
  for (const part of result.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      texts.push(part.value);
      continue;
    }
    if (part instanceof vscode.LanguageModelDataPart) {
      const img = toImage(part);
      if (img && !image) image = img;
    }
  }
  return { text: texts.join("\n"), image };
}

async function invokeBrowserTool(
  vscodeTool: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<Omit<BrowserIpcResponse, "id">> {
  const available = builtinToolNames();
  if (!available.has(vscodeTool)) {
    return {
      ok: false,
      error:
        `VSCode 内置浏览器工具「${vscodeTool}」不可用。请确认 VSCode ≥ 1.110，且设置 workbench.browser.enableChatTools 已开启。`,
    };
  }

  let input: Record<string, unknown>;
  try {
    input = adaptArgs(vscodeTool, args, inputSchemaOf(vscodeTool));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const cts = new vscode.CancellationTokenSource();
  const timer = setTimeout(() => cts.cancel(), timeoutMs);
  try {
    const result = await vscode.lm.invokeTool(
      vscodeTool,
      { input, toolInvocationToken: undefined },
      cts.token,
    );
    const converted = convertResult(result);
    if (vscodeTool === "screenshot_page" && !converted.image) {
      return {
        ok: false,
        error:
          converted.text ||
          "截图未返回图片。请确认页面已分享给 agent（浏览器标签栏的分享按钮）。",
      };
    }
    return { ok: true, text: converted.text || undefined, image: converted.image };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isCancelled(err)) {
      return {
        ok: false,
        error: "用户拒绝了 VSCode 确认，或调用已超时。打开页面 / Playwright 需要在弹窗中点允许。",
      };
    }
    return { ok: false, error: `调用失败：${message}` };
  } finally {
    clearTimeout(timer);
    cts.dispose();
  }
}

function writeResponse(socket: net.Socket, res: BrowserIpcResponse): void {
  socket.write(encodeMessage(res));
}

export function startBrowserIpc(): BrowserIpcHandle {
  const id = randomUUID().replace(/-/g, "").slice(0, 16);
  const path = pipePath(id);
  const token = newToken();
  const server = net.createServer((socket) => {
    let buf: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      try {
        buf = Buffer.concat([buf, chunk]);
        const extracted = extractLines(buf);
        buf = extracted.rest;
        for (const line of extracted.lines) {
          if (!line.trim()) continue;
          void handleLine(socket, token, line);
        }
      } catch (err) {
        writeResponse(socket, {
          id: "?",
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
        socket.destroy();
      }
    });
    socket.on("error", () => undefined);
  });

  if (process.platform !== "win32" && existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      /* 忽略陈旧 socket */
    }
  }

  server.listen(path);
  if (process.platform !== "win32") {
    void chmod(path, 0o600).catch(() => undefined);
  }
  server.on("error", (err) => {
    console.error("[pi-for-vscode] 浏览器 named pipe 监听失败:", err);
  });

  return {
    env: {
      [ENV_IPC]: path,
      [ENV_TOKEN]: token,
    },
    dispose() {
      server.close();
      if (process.platform !== "win32") {
        try {
          unlinkSync(path);
        } catch {
          /* ignore */
        }
      }
    },
  };
}

async function handleLine(
  socket: net.Socket,
  expectedToken: string,
  line: string,
): Promise<void> {
  let id = "?";
  try {
    const req = parseRequest(line);
    id = req.id;
    if (req.token !== expectedToken) {
      writeResponse(socket, { id, ok: false, error: "鉴权失败" });
      socket.destroy();
      return;
    }
    if (isIdeMethod(req.tool)) {
      const key = ideKeyFromMethod(req.tool);
      writeResponse(socket, {
        id,
        ok: true,
        data: key ? getIdeSnapshot(key) : null,
      });
      return;
    }
    const vscodeTool = mapToolName(req.tool);
    const result = await invokeBrowserTool(
      vscodeTool,
      req.args,
      timeoutForTool(vscodeTool),
    );
    writeResponse(socket, { id, ...result });
  } catch (err) {
    writeResponse(socket, {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function autoApproveEnabled(): boolean {
  const cfg = vscode.workspace.getConfiguration();
  if (cfg.get<boolean>("chat.tools.global.autoApprove") === true) return true;
  const nested = cfg.get("chat.tools.autoApprove");
  return nested === true;
}

/** 启动时询问一次是否打开全局自动批准；不静默改设置。 */
export async function maybePromptAutoApprove(
  context: vscode.ExtensionContext,
): Promise<void> {
  const browserToolsOn = vscode.workspace
    .getConfiguration("workbench.browser")
    .get<boolean>("enableChatTools", true);
  if (!browserToolsOn && !context.globalState.get(ENABLE_TOOLS_ASKED)) {
    await context.globalState.update(ENABLE_TOOLS_ASKED, true);
    const pick = await vscode.window.showWarningMessage(
      "pi 浏览器工具需要设置 workbench.browser.enableChatTools。当前已关闭。",
      "打开设置",
    );
    if (pick === "打开设置") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "workbench.browser.enableChatTools",
      );
    }
  }

  if (autoApproveEnabled()) return;
  if (context.globalState.get(AUTO_APPROVE_ASKED)) return;
  await context.globalState.update(AUTO_APPROVE_ASKED, true);
  const choice = await vscode.window.showInformationMessage(
    "pi 浏览器工具：开启 VSCode 全局工具自动批准可减少确认弹窗（所有 Chat 工具都不再询问，不仅限于浏览器）。是否开启？",
    "开启",
    "暂不",
  );
  if (choice !== "开启") return;
  try {
    await vscode.workspace
      .getConfiguration()
      .update("chat.tools.global.autoApprove", true, vscode.ConfigurationTarget.Global);
  } catch {
    void vscode.window.showWarningMessage(
      "无法写入 chat.tools.global.autoApprove，请在设置中手动开启。",
    );
  }
}
