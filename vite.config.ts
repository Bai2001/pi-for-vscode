import { builtinModules } from "node:module";
import { defineConfig } from "vite-plus";

// 纯 VSCode 扩展打包：单文件 CJS（对齐扩展宿主 + F5 调试器）。
// package.json 仍是 "type": "module"（源码/测试走 ESM），入口用 .cjs 让宿主 require。
// vscode、node-pty、@xterm 与 Node 内置模块保持 external，不打进包里。
const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

export default defineConfig({
  // Rolldown 打 CJS 时会把 import.meta 掏成 {}。createRequire 接受文件路径，
  // 用 __filename 即可；不要写成 require("node:url")，否则会撞上源码里的 const require。
  define: {
    "import.meta.url": "__filename",
  },
  build: {
    lib: {
      entry: "src/extension.ts",
      formats: ["cjs"],
      fileName: () => "extension.cjs",
    },
    outDir: "dist",
    emptyOutDir: true,
    target: "node20",
    minify: false,
    sourcemap: false,
    rollupOptions: {
      external: [
        "vscode",
        "node-pty",
        "@xterm/headless",
        "@xterm/addon-serialize",
        "@xterm/xterm",
        ...nodeBuiltins,
      ],
      output: {
        exports: "named",
        codeSplitting: false,
      },
    },
  },
});
