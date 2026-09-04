// pi-for-vscode 内置浏览器工具（运行在终端的 pi 进程内）
// 通过 named pipe 调用宿主的 vscode.lm.invokeTool。
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { callIpc, type IpcResponse } from "./vscode-ipc";

function textAndImage(
  res: IpcResponse,
): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
  const content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
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
      const res = await callIpc("vscode_browser_open_page", { url: params.url }, 120_000, signal);
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
      const res = await callIpc(
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
      selector: Type.Optional(Type.String({ description: "可选 CSS 选择器，只截该元素" })),
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
      const res = await callIpc("vscode_browser_screenshot", args, 30_000, signal);
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
      const res = await callIpc(
        "vscode_browser_playwright",
        { pageId: params.pageId, code: params.code },
        120_000,
        signal,
      );
      return { content: textAndImage(res), details: undefined };
    },
  });
}
