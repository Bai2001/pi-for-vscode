import { build, context } from 'esbuild';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

// 纯 VSCode 扩展（仅 external vscode），无 pi SDK 依赖。
// 输出 ESM（VSCode >= 1.89 支持）。无动态 require，无需 banner。
/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [join(root, 'src/extension.ts')],
  bundle: true,
  outfile: join(root, 'dist/extension.js'),
  external: ['vscode'],
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: watch ? 'inline' : false,
  minify: false,
  logLevel: 'info',
};

if (!existsSync(join(root, 'dist'))) {
  mkdirSync(join(root, 'dist'), { recursive: true });
}

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('[esbuild] watching for changes...');
} else {
  await build(options);
}
