import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { ipcIdentityForWorkspace, pipePath } from "./ipc-endpoint.ts";

describe("ipc-endpoint", () => {
  it("管道路径含 id，Windows 走 named pipe", () => {
    const path = pipePath("abc123def4567890");
    if (process.platform === "win32") {
      assert.equal(path, "\\\\.\\pipe\\pi-for-vscode-browser-abc123def4567890");
    } else {
      assert.match(path, /pi-for-vscode-browser-abc123def4567890\.sock$/);
    }
  });

  it("同一工作区得到同一 id/token，大小写和斜杠不影响", () => {
    const a = ipcIdentityForWorkspace("C:\\\\Users\\\\proj");
    const b = ipcIdentityForWorkspace("c:/users/proj");
    assert.deepEqual(a, b);
    assert.equal(a.id.length, 16);
    assert.match(a.id, /^[0-9a-f]+$/);
    assert.ok(a.token.length > 0);
  });

  it("不同工作区管道不同，无文件夹也有稳定身份", () => {
    const a = ipcIdentityForWorkspace("/a");
    const b = ipcIdentityForWorkspace("/b");
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.token, b.token);
    assert.deepEqual(ipcIdentityForWorkspace(undefined), ipcIdentityForWorkspace(undefined));
  });
});
