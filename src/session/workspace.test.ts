import assert from "node:assert/strict";
import { test } from "vitest";
import { coerceWorkspaceCwd, rootNameForCwd } from "./workspace.ts";

const folders = [
  { name: "frontend", path: "/ws/frontend" },
  { name: "backend", path: "/ws/backend" },
];

test("uses preferred cwd when it is still a workspace folder", () => {
  assert.equal(coerceWorkspaceCwd(folders, "/ws/backend"), "/ws/backend");
});

test("falls back to the first folder when preferred cwd is missing or gone", () => {
  assert.equal(coerceWorkspaceCwd(folders), "/ws/frontend");
  assert.equal(coerceWorkspaceCwd(folders, "/ws/gone"), "/ws/frontend");
  assert.equal(coerceWorkspaceCwd([], "/ws/frontend"), undefined);
});

test("hides root names in a single-folder workspace", () => {
  assert.equal(rootNameForCwd([{ name: "app", path: "/ws/app" }], "/ws/app"), undefined);
});

test("labels sessions with the matching folder name in a multi-root workspace", () => {
  assert.equal(rootNameForCwd(folders, "/ws/backend"), "backend");
});
