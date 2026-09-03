import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  adaptArgs,
  encodeMessage,
  extractLines,
  isIdeMethod,
  mapToolName,
  parseRequest,
  parseResponse,
  timeoutForTool,
} from "./browser-protocol.ts";

describe("browser-protocol", () => {
  it("encodeMessage 以换行结尾", () => {
    const line = encodeMessage({ id: "1" });
    assert.equal(line.endsWith("\n"), true);
    assert.equal(line.includes("\n", 0) && line.indexOf("\n") === line.length - 1, true);
  });

  it("请求往返", () => {
    const raw = encodeMessage({
      id: "a",
      token: "t",
      tool: "vscode_browser_open_page",
      args: { url: "http://localhost:5173" },
    });
    const req = parseRequest(raw.trimEnd());
    assert.equal(req.id, "a");
    assert.equal(req.token, "t");
    assert.equal(req.tool, "vscode_browser_open_page");
    assert.equal(req.args.url, "http://localhost:5173");
  });

  it("响应可带截图", () => {
    const raw = encodeMessage({
      id: "b",
      ok: true,
      text: "ok",
      image: { mimeType: "image/png", data: "AAAA" },
    });
    const res = parseResponse(raw.trimEnd());
    assert.equal(res.ok, true);
    assert.equal(res.image?.mimeType, "image/png");
    assert.equal(res.image?.data, "AAAA");
  });

  it("extractLines 切出完整行并保留半包", () => {
    const buf = Buffer.from('{"id":"1"}\n{"id":"2"}\n{"id":');
    const { lines, rest } = extractLines(buf);
    assert.deepEqual(lines, ['{"id":"1"}', '{"id":"2"}']);
    assert.equal(rest.toString("utf8"), '{"id":');
  });

  it("mapToolName 映射 pi 名到 VSCode 内置 id", () => {
    assert.equal(mapToolName("vscode_browser_open_page"), "open_browser_page");
    assert.equal(mapToolName("vscode_browser_playwright"), "run_playwright_code");
    assert.equal(mapToolName("read_page"), "read_page");
  });

  it("打开和 Playwright 超时更长", () => {
    assert.equal(timeoutForTool("open_browser_page"), 120_000);
    assert.equal(timeoutForTool("run_playwright_code"), 120_000);
    assert.equal(timeoutForTool("screenshot_page"), 30_000);
  });

  it("open 缺 url 抛错", () => {
    assert.throws(() => adaptArgs("open_browser_page", {}, undefined), /url/);
  });

  it("响应可带结构化 data", () => {
    const raw = encodeMessage({
      id: "c",
      ok: true,
      data: { folders: [{ name: "app", path: "/x" }] },
    });
    const res = parseResponse(raw.trimEnd());
    assert.deepEqual(res.data, { folders: [{ name: "app", path: "/x" }] });
  });

  it("识别 ide 查询方法", () => {
    assert.equal(isIdeMethod("get_context"), true);
    assert.equal(isIdeMethod("get_diagnostics"), true);
    assert.equal(isIdeMethod("vscode_browser_open_page"), false);
  });

  it("playwright 按 schema 把 code 改名为 script", () => {
    const out = adaptArgs(
      "run_playwright_code",
      { pageId: "p", code: "await page.title()" },
      { properties: { pageId: {}, script: {} } },
    );
    assert.equal(out.script, "await page.title()");
    assert.equal(out.pageId, "p");
  });
});
