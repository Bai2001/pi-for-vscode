import { builtinModules } from "node:module";
import { defineConfig } from "vite-plus";

// 纯 VSCode 扩展打包：单文件 ESM（VSCode >= 1.89 支持），无 pi SDK 依赖。
// vscode 与 Node 内置模块保持 external，不打进包里。
const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

export default defineConfig({
  build: {
    lib: {
      entry: "src/extension.ts",
      formats: ["es"],
      fileName: () => "extension.js",
    },
    outDir: "dist",
    emptyOutDir: true,
    target: "node20",
    minify: false,
    sourcemap: false,
    rollupOptions: {
      external: ["vscode", ...nodeBuiltins],
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
