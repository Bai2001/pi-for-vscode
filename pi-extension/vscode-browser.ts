// pi-for-vscode 内置浏览器工具（运行在终端的 pi 进程内）
// 通过 VSCode 扩展注入的 named pipe 调用宿主的 vscode.lm.invokeTool。
import { randomUUID } from "node:crypto";
import net from "node:net";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ENV_IPC = "PI_VSCODE_BROWSER_IPC";
const ENV_TOKEN = "PI_VSCODE_BROWSER_TOKEN";
const MAX_LINE_BYTES = 20 * 1024 * 1024;

interface BrowserIpcImage {
  mimeType: string;
  data: string;
}

interface BrowserIpcResponse {
  id: string;
  ok: boolean;
  text?: string;
  image?: BrowserIpcImage;
  error?: string;
}

function requireIpc(): { path: string; token: string } {
  const path = process.env[ENV_IPC];
  const token = process.env[ENV_TOKEN];
  if (!path || !token) {
    throw new Error(
      "不在 VSCode pi 终端中，浏览器工具不可用。请用扩展命令「pi：打开终端会话」启动 pi。",
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

function parseResponse(line: string): BrowserIpcResponse {
  const raw = JSON.parse(line) as unknown;
  if (!raw || typeof raw !== "object") throw new Error("响应不是对象");
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || typeof obj.ok !== "boolean") {
    throw new Error("响应缺少 id/ok");
  }
  const res: BrowserIpcResponse = { id: obj.id, ok: obj.ok };
  if (typeof obj.text === "string") res.text = obj.text;
  if (typeof obj.error === "string") res.error = obj.error;
  if (obj.image && typeof obj.image === "object") {
    const img = obj.image as Record<string, unknown>;
    if (typeof img.mimeType === "string" && typeof img.data === "string") {
      res.image = { mimeType: img.mimeType, data: img.data };
    }
  }
  return res;
}

function callBrowser(
  tool: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<BrowserIpcResponse> {
  const { path, token } = requireIpc();
  const id = randomUUID();
  const payload = `${JSON.stringify({ id, token, tool, args })}\n`;

  return new Promise((resolve, reject) => {
    const socket = net.connect({ path });
    let buf: Buffer = Buffer.alloc(0);
    let settled = false;

    const finish = (err?: Error, res?: BrowserIpcResponse) => {
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
      () => finish(new Error(`浏览器工具超时（${timeoutMs}ms）：${tool}`)),
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
          finish(new Error(res.error || "浏览器工具调用失败"));
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
          `无法连接 VSCode 浏览器桥（${err.message}）。请确认 pi-for-vscode 扩展已激活，并用「pi：打开终端会话」打开终端。`,
        ),
      );
    });
    socket.on("end", () => {
      if (!settled) finish(new Error("浏览器桥连接被关闭，未收到响应"));
    });
  });
}

function textAndImage(res: BrowserIpcResponse): Array<
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
> {
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  > = [];
  if (res.text) content.push({ type: "text", text: res.text });
  if (res.image) {
    content.push({
      type: "image",
      data: res.image.data,
      mimeType: res.image.mimeType,
    });
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "(empty)" });
  }
  return content;
}

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "vscode_browser_open_page",
    label: "打开 VSCode 内置浏览器",
    description:
      "在 VSCode 集成浏览器中打开 URL，返回 pageId。后续 read/screenshot/playwright 都必须带这个 pageId。不要为同一 URL 反复打开。",
    promptSnippet: "在 VSCode 内置浏览器打开页面并返回 pageId",
    promptGuidelines: [
      "改前端并要验证页面时，用 vscode_browser_open_page 打开本地 dev server（必须传 url），拿到 pageId 后再截图或跑 Playwright。",
      "vscode_browser_open_page 可能弹出 VSCode「分享给 agent」确认；用户取消则不要重试同一 URL 太多次。",
    ],
    parameters: Type.Object({
      url: Type.String({
        description: "要打开的 URL（必填），例如 http://localhost:5173",
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const res = await callBrowser(
        "vscode_browser_open_page",
        { url: params.url },
        120_000,
        signal,
      );
      return { content: textAndImage(res), details: undefined };
    },
  });

  pi.registerTool({
    name: "vscode_browser_read_page",
    label: "读取内置浏览器页面",
    description:
      "读取已分享的 VSCode 集成浏览器页面的无障碍/文本快照。需要 open_page 返回的 pageId。",
    promptSnippet: "读取 VSCode 内置浏览器页面文本快照",
    promptGuidelines: [
      "用 vscode_browser_read_page 断言文案、按钮和结构；纯视觉问题改用 vscode_browser_screenshot。",
    ],
    parameters: Type.Object({
      pageId: Type.String({
        description: "vscode_browser_open_page 返回的 pageId",
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const res = await callBrowser(
        "vscode_browser_read_page",
        { pageId: params.pageId },
        30_000,
        signal,
      );
      return { content: textAndImage(res), details: undefined };
    },
  });

  pi.registerTool({
    name: "vscode_browser_screenshot",
    label: "截取内置浏览器页面",
    description:
      "对已分享的 VSCode 集成浏览器页面截图，图片会直接交给模型。需要 pageId。可用 selector 或 read_page 的 aria-ref 截单个元素。",
    promptSnippet: "截取 VSCode 内置浏览器页面给模型看",
    promptGuidelines: [
      "视觉验收用 vscode_browser_screenshot（返回图片）。点击、输入不要用截图，改走 vscode_browser_playwright。",
    ],
    parameters: Type.Object({
      pageId: Type.String({
        description: "vscode_browser_open_page 返回的 pageId",
      }),
      selector: Type.Optional(
        Type.String({ description: "可选 CSS 选择器，只截该元素" }),
      ),
      ref: Type.Optional(
        Type.String({
          description: "vscode_browser_read_page 得到的 aria-ref，替代 selector",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const args: Record<string, unknown> = { pageId: params.pageId };
      if (params.selector) args.selector = params.selector;
      if (params.ref) args.ref = params.ref;
      const res = await callBrowser(
        "vscode_browser_screenshot",
        args,
        30_000,
        signal,
      );
      return { content: textAndImage(res), details: undefined };
    },
  });

  pi.registerTool({
    name: "vscode_browser_playwright",
    label: "在内置浏览器跑 Playwright",
    description:
      "在已分享的 VSCode 集成浏览器页面上执行 Playwright 代码（可使用 page 对象）。点击、输入、悬停、拖拽、跳转都走这个工具。每次调用可能弹出 VSCode 确认。",
    promptSnippet: "在 VSCode 内置浏览器执行 Playwright 代码",
    promptGuidelines: [
      "点击、输入、hover、拖拽、填表一律用 vscode_browser_playwright（参数 pageId + code，code 里用 page）。不要为这些操作单独找点击工具。",
    ],
    parameters: Type.Object({
      pageId: Type.String({
        description: "vscode_browser_open_page 返回的 pageId",
      }),
      code: Type.String({
        description:
          "在已分享页面上执行的 Playwright 代码，可使用 page，例如 await page.getByRole('button', { name: '提交' }).click()",
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const res = await callBrowser(
        "vscode_browser_playwright",
        { pageId: params.pageId, code: params.code },
        120_000,
        signal,
      );
      return { content: textAndImage(res), details: undefined };
    },
  });
}
