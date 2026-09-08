import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(
  /^([a-zA-Z]):/,
  (_, drive) => `${drive.toUpperCase()}:`,
);

const child = spawn(
  process.execPath,
  [resolve(root, "node_modules/vitest/vitest.mjs"), ...process.argv.slice(2)],
  {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  },
);
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
