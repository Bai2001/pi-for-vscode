import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { onIdeSnapshot, publishIdeSnapshot, snapshotFingerprint } from "./ide-store.ts";

describe("ide-store", () => {
  it("fingerprint 忽略 updatedAt", () => {
    assert.equal(
      snapshotFingerprint({ enabled: true, updatedAt: 1 }),
      snapshotFingerprint({ enabled: true, updatedAt: 2 }),
    );
  });

  it("内容不变时不通知订阅者", () => {
    const events: unknown[][] = [];
    const stop = onIdeSnapshot((key, value) => events.push([key, value]));
    try {
      const file = `t-${Math.random()}.ts`;
      publishIdeSnapshot("context", { enabled: true, activeFile: file, updatedAt: 1 });
      publishIdeSnapshot("context", { enabled: true, activeFile: file, updatedAt: 2 });
      publishIdeSnapshot("context", { enabled: true, activeFile: `${file}x`, updatedAt: 3 });
      assert.equal(events.length, 2);
      assert.equal(events[0]?.[0], "context");
      assert.equal(events[1]?.[0], "context");
    } finally {
      stop();
    }
  });
});
