/** pi ↔ VSCode 宿主浏览器桥的 NDJSON 协议（纯逻辑，可供单测）。 */

export const ENV_IPC = "PI_VSCODE_BROWSER_IPC";
export const ENV_TOKEN = "PI_VSCODE_BROWSER_TOKEN";

/** 单行 JSON 上限（截图 base64 可能到数 MB） */
export const MAX_LINE_BYTES = 20 * 1024 * 1024;

export const IDE_METHODS = new Set([
  "get_context",
  "get_diagnostics",
  "get_workspace",
  "get_language_config",
]);

/** 长连接订阅：宿主在 context/workspace 变化时持续推送，不关闭 socket。 */
export const SUBSCRIBE_IDE = "subscribe_ide";

export const PI_TO_VSCODE_TOOL: Record<string, string> = {
  vscode_browser_open_page: "open_browser_page",
  vscode_browser_read_page: "read_page",
  vscode_browser_screenshot: "screenshot_page",
  vscode_browser_playwright: "run_playwright_code",
};

const SLOW_TOOLS = new Set(["open_browser_page", "run_playwright_code"]);
const SLOW_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface BrowserIpcRequest {
  id: string;
  token: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface BrowserIpcImage {
  mimeType: string;
  data: string;
}

export interface BrowserIpcResponse {
  id: string;
  ok: boolean;
  text?: string;
  data?: unknown;
  image?: BrowserIpcImage;
  error?: string;
}

export function isIdeMethod(name: string): boolean {
  return IDE_METHODS.has(name);
}

export function mapToolName(name: string): string {
  return PI_TO_VSCODE_TOOL[name] ?? name;
}

export function timeoutForTool(vscodeToolName: string): number {
  return SLOW_TOOLS.has(vscodeToolName) ? SLOW_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

export function encodeMessage(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function parseRequest(line: string): BrowserIpcRequest {
  const raw = JSON.parse(line) as unknown;
  if (!raw || typeof raw !== "object") {
    throw new Error("请求不是对象");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || !obj.id) {
    throw new Error("缺少 id");
  }
  if (typeof obj.token !== "string") {
    throw new Error("缺少 token");
  }
  if (typeof obj.tool !== "string" || !obj.tool) {
    throw new Error("缺少 tool");
  }
  const args =
    obj.args && typeof obj.args === "object" && !Array.isArray(obj.args)
      ? (obj.args as Record<string, unknown>)
      : {};
  return { id: obj.id, token: obj.token, tool: obj.tool, args };
}

export function parseResponse(line: string): BrowserIpcResponse {
  const raw = JSON.parse(line) as unknown;
  if (!raw || typeof raw !== "object") {
    throw new Error("响应不是对象");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || !obj.id) {
    throw new Error("缺少 id");
  }
  if (typeof obj.ok !== "boolean") {
    throw new Error("缺少 ok");
  }
  const res: BrowserIpcResponse = { id: obj.id, ok: obj.ok };
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

/** 从字节缓冲切出完整行；超长行抛错。 */
export function extractLines(buffer: Buffer): { lines: string[]; rest: Buffer } {
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

/**
 * 按 VSCode 工具 inputSchema 做浅适配：
 * - open：url ↔ uri
 * - playwright：code ↔ playwrightCode/script/expression/source
 */
export function adaptArgs(
  vscodeToolName: string,
  args: Record<string, unknown>,
  inputSchema: unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  const props = schemaProperties(inputSchema);

  if (vscodeToolName === "open_browser_page") {
    if (typeof out.url !== "string" || !out.url.trim()) {
      throw new Error("open_browser_page 需要非空 url");
    }
    if (props && props.uri && !props.url && out.uri === undefined) {
      out.uri = out.url;
    }
  }

  if (vscodeToolName === "run_playwright_code" && typeof out.code === "string") {
    if (props && !props.code) {
      for (const key of ["playwrightCode", "script", "expression", "source"]) {
        if (props[key] && out[key] === undefined) {
          out[key] = out.code;
          break;
        }
      }
    }
  }

  return out;
}

function schemaProperties(inputSchema: unknown): Record<string, unknown> | undefined {
  if (!inputSchema || typeof inputSchema !== "object") return undefined;
  const props = (inputSchema as { properties?: unknown }).properties;
  if (!props || typeof props !== "object") return undefined;
  return props as Record<string, unknown>;
}
