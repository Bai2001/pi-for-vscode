import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { pickLanguageConfigForCwd, type LanguageConfigSnapshot } from "./language-config.ts";

function snapshot(roots: Array<{ resource: string; name: string }>): LanguageConfigSnapshot {
  return {
    updatedAt: 1,
    roots: roots.map((root) => ({
      ...root,
      typescript: { tsdk: `${root.name}-tsdk` },
      basedpyright: {
        typeCheckingMode: `${root.name}-mode`,
        interpreterPath: `${root.name}-python`,
        venvPath: null,
      },
    })),
  };
}

test("picks the language config for the workspace root that contains cwd", () => {
  const frontend = join("/ws", "frontend");
  const backend = join("/ws", "backend");
  const config = pickLanguageConfigForCwd(
    snapshot([
      { resource: frontend, name: "frontend" },
      { resource: backend, name: "backend" },
    ]),
    join(backend, "src"),
  );
  assert.equal(config?.name, "backend");
  assert.equal(config?.basedpyright.interpreterPath, "backend-python");
});

test("prefers the longest matching root when folders nest", () => {
  const ws = join("/ws");
  const app = join("/ws", "app");
  const config = pickLanguageConfigForCwd(
    snapshot([
      { resource: ws, name: "ws" },
      { resource: app, name: "app" },
    ]),
    join(app, "main.py"),
  );
  assert.equal(config?.name, "app");
});

test("returns undefined when cwd is outside every workspace root", () => {
  assert.equal(
    pickLanguageConfigForCwd(
      snapshot([{ resource: join("/ws", "app"), name: "app" }]),
      join("/other", "file.py"),
    ),
    undefined,
  );
});
