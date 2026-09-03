// pi 侧 named pipe 客户端（浏览器工具 + 编辑器快照查询共用）。
import { randomUUID } from "node:crypto";
import net from "node:net";

export const ENV_IPC = "PI_VSCODE_BROWSER_IPC";
export const ENV_TOKEN = "PI_VSCODE_BROWSER_TOKEN";
const MAX_LINE_BYTES = 20 * 1024 * 1024;

export interface IpcImage {
  mimeType: string;
  data: string;
}

export interface IpcResponse {
  id: string;
  ok: boolean;
  text?: string;
  data?: unknown;
  image?: IpcImage;
  error?: string;
}

export function hasIpc(): boolean {
  return Boolean(process.env[ENV_IPC] && process.env[ENV_TOKEN]);
}

function requireIpc(): { path: string; token: string } {
  const path = process.env[ENV_IPC];
  const token = process.env[ENV_TOKEN];
  if (!path || !token) {
    throw new Error(
      "不在 VSCode pi 终端中。请用扩展命令「pi：打开终端会话」启动 pi。",
    );
  }
  return { path, token };
}

function extractLines(buffer: Buffer): { lines: string[]; rest: Buffer } {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] !== 0x0a) continue;
    const slice = buffer.subarray(start, i);
    if (slice.length > MAX_LINE_BYTES) {
      throw new Error(`报文超过 ${MAX_LINE_BYTES} 字节`);
    }
    lines.push(slice.toString("utf8"));
    start = i + 1;
  }
  const rest = buffer.subarray(start);
  if (rest.length > MAX_LINE_BYTES) {
    throw new Error(`报文超过 ${MAX_LINE_BYTES} 字节`);
  }
  return { lines, rest };
}

function parseResponse(line: string): IpcResponse {
  const raw = JSON.parse(line) as unknown;
  if (!raw || typeof raw !== "object") throw new Error("响应不是对象");
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || typeof obj.ok !== "boolean") {
    throw new Error("响应缺少 id/ok");
  }
  const res: IpcResponse = { id: obj.id, ok: obj.ok };
  if (typeof obj.text === "string") res.text = obj.text;
  if (typeof obj.error === "string") res.error = obj.error;
  if ("data" in obj) res.data = obj.data;
  if (obj.image && typeof obj.image === "object") {
    const img = obj.image as Record<string, unknown>;
    if (typeof img.mimeType === "string" && typeof img.data === "string") {
      res.image = { mimeType: img.mimeType, data: img.data };
    }
  }
  return res;
}

export function callIpc(
  tool: string,
  args: Record<string, unknown> = {},
  timeoutMs = 8_000,
  signal?: AbortSignal,
): Promise<IpcResponse> {
  const { path, token } = requireIpc();
  const id = randomUUID();
  const payload = `${JSON.stringify({ id, token, tool, args })}\n`;

  return new Promise((resolve, reject) => {
    const socket = net.connect({ path });
    let buf: Buffer = Buffer.alloc(0);
    let settled = false;

    const finish = (err?: Error, res?: IpcResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      if (err) reject(err);
      else resolve(res!);
    };

    const onAbort = () => finish(new Error("已取消"));
    const timer = setTimeout(
      () => finish(new Error(`VSCode 桥超时（${timeoutMs}ms）：${tool}`)),
      timeoutMs,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    socket.on("connect", () => {
      socket.write(payload);
    });
    socket.on("data", (chunk) => {
      try {
        buf = Buffer.concat([buf, chunk]);
        const extracted = extractLines(buf);
        buf = extracted.rest;
        const line = extracted.lines.find((l) => l.trim());
        if (!line) return;
        const res = parseResponse(line);
        if (!res.ok) {
          finish(new Error(res.error || "VSCode 桥调用失败"));
          return;
        }
        finish(undefined, res);
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
    socket.on("error", (err) => {
      finish(
        new Error(
          `无法连接 VSCode 桥（${err.message}）。请确认 pi-for-vscode 扩展已激活，并用「pi：打开终端会话」打开终端。`,
        ),
      );
    });
    socket.on("end", () => {
      if (!settled) finish(new Error("VSCode 桥连接被关闭，未收到响应"));
    });
  });
}

export async function callIpcData<T>(
  tool: string,
  timeoutMs = 8_000,
): Promise<T | null> {
  const res = await callIpc(tool, {}, timeoutMs);
  if (res.data === undefined || res.data === null) return null;
  return res.data as T;
}

export interface IdeSubscribeData {
  context?: unknown;
  workspace?: unknown;
}

/** 长连接订阅 context/workspace 推送。返回取消函数。 */
export function subscribeIde(onData: (data: IdeSubscribeData) => void): () => void {
  if (!hasIpc()) return () => undefined;
  let closed = false;
  let socket: net.Socket | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnecting = false;
  let attempt = 0;

  const clearRetry = () => {
    if (retryTimer === undefined) return;
    clearTimeout(retryTimer);
    retryTimer = undefined;
  };

  const scheduleReconnect = () => {
    if (closed || reconnecting) return;
    reconnecting = true;
    socket?.destroy();
    socket = undefined;
    const delay = Math.min(1000 * 2 ** attempt, 8000);
    attempt += 1;
    retryTimer = setTimeout(() => {
      reconnecting = false;
      connect();
    }, delay);
    retryTimer.unref?.();
  };

  const connect = () => {
    if (closed) return;
    clearRetry();
    const { path, token } = requireIpc();
    const id = randomUUID();
    const s = net.connect({ path });
    socket = s;
    let buf: Buffer = Buffer.alloc(0);

    s.on("connect", () => {
      attempt = 0;
      s.write(`${JSON.stringify({ id, token, tool: "subscribe_ide", args: {} })}\n`);
    });
    s.on("data", (chunk) => {
      try {
        buf = Buffer.concat([buf, chunk]);
        const extracted = extractLines(buf);
        buf = extracted.rest;
        for (const line of extracted.lines) {
          if (!line.trim()) continue;
          const res = parseResponse(line);
          if (!res.ok) {
            s.destroy();
            return;
          }
          if (res.data && typeof res.data === "object") {
            onData(res.data as IdeSubscribeData);
          }
        }
      } catch {
        s.destroy();
      }
    });
    s.on("error", () => {
      if (socket !== s) return;
      scheduleReconnect();
    });
    s.on("close", () => {
      if (socket !== s) return;
      scheduleReconnect();
    });
  };

  connect();

  return () => {
    closed = true;
    clearRetry();
    reconnecting = true;
    socket?.destroy();
    socket = undefined;
  };
}

// 本文件是共享客户端，不是扩展入口；但会被同步到 ~/.pi/agent/extensions/*.ts，
// pi 会把该目录下每个 .ts 当扩展加载，因此必须导出空工厂，否则启动失败。
export default function (): void {}
