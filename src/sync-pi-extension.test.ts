import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPiExtensionSourceFile } from "./sync-pi-extension.ts";

describe("isPiExtensionSourceFile", () => {
  it("同步扩展入口和共享模块，跳过测试文件", () => {
    assert.equal(isPiExtensionSourceFile("vscode-context.ts"), true);
    assert.equal(isPiExtensionSourceFile("vscode-ipc.ts"), true);
    assert.equal(isPiExtensionSourceFile("vscode-context.test.ts"), false);
    assert.equal(isPiExtensionSourceFile("tsconfig.json"), false);
  });
});
