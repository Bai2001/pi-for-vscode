// pi-for-vscode 内置语言诊断工具（运行在终端的 pi 进程内）
//
// VSCode 通道（vscode_get_diagnostics）只能拿到「已打开文件」的增量诊断；
// Vue/Volar 等扩展还只诊断「可见编辑器」，大量场景查不到。本工具改用命令行
// 检查器（vue-tsc / tsc / basedpyright[+ruff]），无头、可靠、全量，且配置来源
// 与编辑器一致：
//
//   复用同一套配置文件（tsconfig.json / pyrightconfig.json / [tool.basedpyright]），
//   这些文件语言服务器和 CLI 都会向上探测并读取，天然一致；编辑器侧的语言
//   配置（typescript.tsdk、basedpyright.analysis.* 等）经 language-config.json
//   由 VSCode 扩展合并后中转过来作兜底。
//
// 返回时与 VSCode 全局诊断合并去重，互相补足。
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface CliDiagnostic {
  file: string;
  line: number;
  col: number;
  severity: "error" | "warning";
  message: string;
  code: string;
  source: string; // tsc / vue-tsc / basedpyright / ruff
}

interface VscodeDiagnostic {
  file: string;
  line: number;
  col: number;
  severity: "error" | "warning";
  message: string;
  source?: string;
}

// 编辑器语言配置快照（由 VSCode 扩展用 getConfiguration 合并后写入），
// 供本工具把「只在编辑器设置里配过的值」桥接给 CLI，保证 CLI 与编辑器一致。
interface LanguageConfig {
  updatedAt: number;
  resource: string | null;
  typescript: { tsdk: string | null };
  basedpyright: {
    typeCheckingMode: string | null;
    interpreterPath: string | null;
    venvPath: string | null;
  };
}

// 与 VSCode 扩展一致的编码
const IDE_DIR = join(
  homedir(),
  ".pi",
  "agent",
  "vscode-ide",
  process
    .cwd()
    .replace(/[^a-zA-Z0-9]/g, "-")
    .toLowerCase(),
);
const DIAGNOSTICS_FILE = join(IDE_DIR, "diagnostics.json");
const LANGUAGE_CONFIG_FILE = join(IDE_DIR, "language-config.json");

/** 单次 CLI 检查超时（vue-tsc/tsc 全项目检查慢，给足时间） */
const CLI_TIMEOUT_MS = 180_000;
/** 单语言最大文件数（防误用） */
const MAX_FILES = 50;

// ============ 读取语言配置快照 ============
function readLanguageConfig(): LanguageConfig | undefined {
  try {
    const raw = JSON.parse(
      readFileSync(LANGUAGE_CONFIG_FILE, "utf8"),
    ) as LanguageConfig;
    if (typeof raw?.updatedAt === "number") return raw;
  } catch {
    /* 扩展未写入 */
  }
  return undefined;
}

// ============ 执行命令 ============
function run(
  cmd: string,
  args: string[],
  cwd: string,
): { ok: boolean; stdout: string; stderr: string; code: number | null } {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CLI_TIMEOUT_MS,
      windowsHide: true,
    });
    return { ok: true, stdout, stderr: "", code: 0 };
  } catch (e) {
    const err = e as {
      stdout?: string;
      stderr?: string;
      status?: number | null;
      message?: string;
    };
    // tsc/vue-tsc 有诊断时 exit code 非 0，但 stdout 有正常输出，不算失败
    return {
      ok: false,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message ?? "",
      code: err.status ?? null,
    };
  }
}

// ============ 命令探测（复用编辑器同款配置文件，保证一致） ============
// CLI 诊断与编辑器一致的关键是复用同一套配置文件（tsconfig.json /
// pyrightconfig.json / [tool.basedpyright]），这些文件语言服务器和 CLI 都会
// 向上探测并读取，天然一致。这里只定位工具可执行入口，不读 package.json
// scripts（用户自定义脚本无法保证与语言服务器行为一致，反而破坏语义）。

/** 向上查找目录里是否存在满足条件的文件/目录 */
function findUp(
  startDir: string,
  needle: (d: string) => boolean,
): string | undefined {
  let dir = startDir;
  while (true) {
    if (needle(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** 用 node 直接跑某个包的 bin 入口（避免 .cmd shim 在 execFileSync 下的 shell 问题）
 * @param binKey 包 bin 对象里的键名（如 typescript 包的键是 "tsc"，vue-tsc 则是 "vue-tsc"）。缺省用包名。 */
function nodeRun(
  cwd: string,
  packageName: string,
  args: string[],
  binKey: string = packageName,
): { cmd: string; args: string[] } | undefined {
  const pkgJson = join("node_modules", packageName, "package.json");
  const pkgDir = findUp(cwd, (d) => existsSync(join(d, pkgJson)));
  if (!pkgDir) return undefined;
  try {
    const pkg = JSON.parse(
      readFileSync(join(pkgDir, pkgJson), "utf8"),
    ) as { bin?: string | Record<string, string> };
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[binKey];
    if (!bin) return undefined;
    const entry = join(pkgDir, "node_modules", packageName, bin);
    if (!existsSync(entry)) return undefined;
    return { cmd: process.execPath, args: [entry, ...args] };
  } catch {
    return undefined;
  }
}

// ============ TS ============
function resolveTsCmd(cwd: string): { cmd: string; args: string[] } | undefined {
  // typescript 包的 bin 键名是 "tsc"（= tsc CLI）
  const found = nodeRun(cwd, "typescript", ["--noEmit", "--pretty", "false"], "tsc");
  if (found) return found;
  // 兜底：pnpm 符号链接结构下 package.json 的 bin 可能不是标准入口
  const tscJs = findUp(cwd, (d) =>
    existsSync(join(d, "node_modules", "typescript", "bin", "tsc")),
  );
  if (tscJs) {
    const entry = join(tscJs, "node_modules", "typescript", "bin", "tsc");
    if (existsSync(entry)) {
      return {
        cmd: process.execPath,
        args: [entry, "--noEmit", "--pretty", "false"],
      };
    }
  }
  return undefined;
}

// ============ VUE ============
function resolveVueCmd(cwd: string): { cmd: string; args: string[] } | undefined {
  // vue-tsc 包的 bin 键名是 "vue-tsc"（= 包名，用默认）
  return nodeRun(cwd, "vue-tsc", ["--noEmit", "--pretty", "false"]);
}

// ============ PY（basedpyright 为主，ruff 可选）============
/**
 * 构建 basedpyright CLI 命令，桥接编辑器设置与 CLI 配置的对等关系。
 *
 * 优先级（与语言服务器一致）：项目配置文件（pyrightconfig.json /
 * pyproject.toml）> 编辑器设置。CLI 本身会向上探测并读项目配置文件，天然
 * 一致；这里只在「项目无配置文件」时，把编辑器设置桥接过去（避免 CLI 落回
 * 默认值，与编辑器行为分叉）。
 *
 * 关键：CLI 模式下命令行参数会覆盖配置文件（basedpyright 源码确认），所以
 * 有项目配置文件时绝不能传任何覆盖参数，否则破坏优先级。
 *
 * key 映射（编辑器设置 -> 配置文件/CLI，来自 basedpyright 扩展源码确认）：
 *   typeCheckingMode         -> 配置文件 typeCheckingMode（同名）
 *   python.defaultInterpreterPath -> --pythonpath（CLI flag，改名）
 *   python.venvPath          -> --venvpath（CLI flag，同名）
 */
function buildBasedpyrightArgs(
  cwd: string,
  config: LanguageConfig | undefined,
): { cmd: string; args: string[] } {
  const args: string[] = [];

  // 是否有项目配置文件（pyrightconfig.json 优先于 pyproject.toml）
  const hasProjectConfig =
    findUp(cwd, (d) =>
      existsSync(join(d, "pyrightconfig.json")) ||
      existsSync(join(d, "pyproject.toml")),
    ) !== undefined;

  const bp = config?.basedpyright;

  // 仅当项目无配置文件时，才桥接编辑器设置（否则 CLI 命令行参数会覆盖
  // 项目配置文件，破坏「项目配置优先」的语义）。
  if (!hasProjectConfig) {
    // 1. 解释器路径（python.defaultInterpreterPath -> --pythonpath）
    if (bp?.interpreterPath) {
      const resolved = resolveWorkspaceVar(
        bp.interpreterPath,
        config?.resource ?? null,
      );
      if (resolved) args.push("--pythonpath", resolved);
    }

    // 2. venv 目录（python.venvPath -> --venvpath）
    if (bp?.venvPath) {
      const resolved = resolveWorkspaceVar(
        bp.venvPath,
        config?.resource ?? null,
      );
      if (resolved) args.push("--venvpath", resolved);
    }

    // 3. typeCheckingMode：编辑器显式改过且非默认（recommended）时合成临时配置
    if (
      bp?.typeCheckingMode &&
      bp.typeCheckingMode !== "recommended" // recommended 与 CLI 默认一致，无需桥接
    ) {
      const tmp = makeTempPyrightConfig(bp.typeCheckingMode, cwd);
      if (tmp) args.push("-p", tmp);
    }
  }

  args.push("--outputjson");
  return { cmd: "uvx", args: ["basedpyright", ...args] };
}

/** 解析 ${workspaceFolder} / ${workspaceRoot} 占位符为绝对路径。
 * 裸命令名（如 VSCode 默认的 "python"，无路径分隔符）原样传递，交给
 * basedpyright 自己按 PATH 解析，不能误拼成工作区相对路径。 */
function resolveWorkspaceVar(value: string, resource: string | null): string | null {
  if (resource) {
    value = value.replace(/\$\{(workspaceFolder|workspaceRoot)\}/gi, resource);
  }
  if (isAbsolute(value)) return value;
  // 裸命令名（如 "python"）：原样传递
  if (!/[/\\]/.test(value)) return value;
  // 相对路径：相对工作区根解析
  if (resource) return resolve(resource, value);
  return null;
}

/** 生成仅含 typeCheckingMode 的临时 pyrightconfig.json，返回路径。
 * 注意：-p 指定配置文件后，basedpyright 会把「配置文件所在目录」当作项目根，
 * 只分析其下的文件——临时目录里没有代码，会静默返回 0 条诊断。所以必须在
 * 临时配置里用绝对路径 include 把工作区目录显式纳入分析范围。 */
function makeTempPyrightConfig(
  typeCheckingMode: string,
  cwd: string,
): string | null {
  try {
    const dir = mkdtempSync(join(tmpdir(), "pi-pyright-"));
    const file = join(dir, "pyrightconfig.json");
    writeFileSync(
      file,
      JSON.stringify({ typeCheckingMode, include: [cwd] }),
      "utf8",
    );
    return file;
  } catch {
    return null;
  }
}

function resolveRuffCmd(cwd: string): { cmd: string; args: string[] } | undefined {
  // 项目本地 .venv 里的 ruff 优先，其次系统 PATH
  const venvBin = process.platform === "win32" ? "Scripts" : "bin";
  const venvRuff = process.platform === "win32" ? "ruff.exe" : "ruff";
  const local = findUp(cwd, (d) =>
    existsSync(join(d, ".venv", venvBin, venvRuff)),
  );
  if (local) {
    return { cmd: join(local, ".venv", venvBin, venvRuff), args: ["check"] };
  }
  return { cmd: "ruff", args: ["check"] };
}

// ============ 解析 ============
function parseTscLines(text: string, source: string): CliDiagnostic[] {
  const re = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm;
  const out: CliDiagnostic[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({
      file: m[1],
      line: +m[2],
      col: +m[3],
      severity: m[4] === "error" ? "error" : "warning",
      code: m[5],
      message: m[6],
      source,
    });
  }
  return out;
}

function parseBasedpyright(text: string): CliDiagnostic[] {
  try {
    const j = JSON.parse(text) as {
      generalDiagnostics?: Array<{
        file: string;
        severity: string;
        message: string;
        rule?: string;
        range: { start: { line: number; character: number } };
      }>;
    };
    return (j.generalDiagnostics ?? []).map((d) => ({
      file: d.file,
      line: d.range.start.line + 1,
      col: d.range.start.character + 1,
      severity: d.severity === "error" ? "error" : "warning",
      code: d.rule ?? "",
      message: d.message.split("\n")[0],
      source: "basedpyright",
    }));
  } catch {
    return [];
  }
}

function parseRuff(text: string): CliDiagnostic[] {
  const blocks = text.split(/\n\n+/);
  const out: CliDiagnostic[] = [];
  for (const b of blocks) {
    const c = b.match(/^([A-Z]+\d+)\s+(.+)$/m);
    const l = b.match(/-->\s+(.+?):(\d+):(\d+)$/m);
    if (c && l) {
      out.push({
        file: l[1],
        line: +l[2],
        col: +l[3],
        severity: "warning",
        code: c[1],
        message: c[2].trim(),
        source: "ruff",
      });
    }
  }
  return out;
}

// ============ VSCode 诊断读取（用于合并互补）============
function readVscodeDiagnostics():
  | { total: number; items: VscodeDiagnostic[] }
  | undefined {
  try {
    const raw = JSON.parse(readFileSync(DIAGNOSTICS_FILE, "utf8")) as {
      total: number;
      roots?: Array<{ root: string; diagnostics?: VscodeDiagnostic[] }>;
      diagnostics?: VscodeDiagnostic[];
    };
    const items: VscodeDiagnostic[] = [];
    if (Array.isArray(raw.roots)) {
      for (const r of raw.roots) {
        items.push(...(r.diagnostics ?? []));
      }
    } else if (Array.isArray(raw.diagnostics)) {
      items.push(...raw.diagnostics);
    }
    return { total: raw.total ?? items.length, items };
  } catch {
    return undefined;
  }
}

// ============ 去重与合并 ============
/** 去重 key：路径必须归一化后再比较。各来源格式不一致——VSCode 桥接文件、
 * ruff、tsc/vue-tsc 输出相对路径，basedpyright 输出绝对路径，且 Windows
 * 盘符大小写可能不同（c:\ vs C:\）。统一为「绝对路径 + 正斜杠 + 盘符小写」。 */
function diagKey(d: { file: string; line: number; col: number }, cwd: string): string {
  const abs = isAbsolute(d.file) ? d.file : resolve(cwd, d.file);
  const norm = normPath(abs).replace(
    /^([A-Z]):\//,
    (_m, ch: string) => `${ch.toLowerCase()}:/`,
  );
  return `${norm}:${d.line}:${d.col}`;
}

/** 路径归一（Windows 反斜杠统一为 /，便于比较） */
function normPath(p: string): string {
  return p.replace(/\\/g, "/");
}

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "run_diagnostics",
    label: "运行语言诊断（CLI）",
    description:
      "用命令行语言检查器（vue-tsc / tsc / basedpyright + ruff）对项目做无头、全量的诊断，覆盖 VSCode 只能看到已打开文件的局限（如 Vue/Volar 只诊断可见编辑器）。配置与编辑器一致：复用项目的 tsconfig/pyrightconfig/[tool.basedpyright]（语言服务器与 CLI 都读这些文件，天然一致），VSCode 语言扩展配置经 language-config.json 兜底。返回 CLI 诊断并合并 VSCode 全局诊断去重互补。",
    promptSnippet: "运行 CLI 语言诊断（vue/ts/py）",
    promptGuidelines: [
      "改完代码后做最终验证时用此工具（全量、无头、可靠）；快速看当前编辑器错误用 vscode_get_diagnostics。",
      "不传 files 时全项目检查（慢，vue-tsc/tsc 大项目可能 30s~2min）；传 files 限定范围但底层仍是全项目编译（按文件过滤结果）。",
      "py 用 basedpyright（类型检查，与扩展同源）+ ruff（可选 lint，项目/系统有 ruff 时才跑）。",
    ],
    parameters: Type.Object({
      files: Type.Optional(
        Type.Union([Type.String(), Type.Array(Type.String())], {
          description: "要检查的文件（相对 cwd 或绝对路径）。不传则全项目检查。",
        }),
      ),
      language: Type.Optional(
        Type.Union(
          [
            Type.Literal("ts"),
            Type.Literal("vue"),
            Type.Literal("py"),
            Type.Literal("auto"),
          ],
          { description: "检查语言，默认 auto（按文件扩展名推断）" },
        ),
      ),
      includeRuff: Type.Optional(
        Type.Boolean({
          description:
            "py 时是否同时跑 ruff lint，默认 true（项目/系统装有 ruff 才生效）",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const cwd = process.cwd();
      const config = readLanguageConfig();

      const files = resolveFiles(cwd, params.files);
      const language = inferLanguage(params.language, files);

      let cliItems: CliDiagnostic[] = [];
      let cliSource = "";
      let cliError: string | undefined;
      try {
        const result = runCliCheck(cwd, language, params.includeRuff, config);
        if ("error" in result) {
          cliError = result.error;
        } else {
          cliItems = filterByFiles(result.items, files, cwd);
          cliSource = result.source;
        }
      } catch (e) {
        cliError = e instanceof Error ? e.message : String(e);
      }

      const vscode = readVscodeDiagnostics();

      const { merged, cliCount, vscodeMatched, vscodeUnique } =
        mergeDiagnostics(cliItems, vscode?.items ?? [], files, cwd);

      const text = renderResult({
        language,
        cliSource,
        cliError,
        cliCount,
        vscodeMatched,
        vscodeUnique,
        merged,
        files,
        vscodeTotal: vscode?.total,
      });

      return {
        content: [{ type: "text", text }],
        details: {
          language,
          cliItems: cliItems.length,
          cliError,
          vscodeTotal: vscode?.total ?? 0,
          vscodeMatched,
          vscodeUnique,
          merged: merged.length,
        },
      };
    },
  });
}

// ============ 工具辅助函数 ============
function resolveFiles(cwd: string, files?: string | string[]): string[] | undefined {
  if (!files) return undefined;
  const raw = Array.isArray(files) ? files : [files];
  return raw.map((f) => resolve(cwd, f)).slice(0, MAX_FILES);
}

function inferLanguage(
  language: string | undefined,
  files: string[] | undefined,
): "ts" | "vue" | "py" {
  if (language === "ts" || language === "vue" || language === "py") {
    return language;
  }
  if (files?.length) {
    if (files.some((f) => f.toLowerCase().endsWith(".vue"))) return "vue";
    if (files.some((f) => f.toLowerCase().endsWith(".py"))) return "py";
    if (files.some((f) => /\.(ts|tsx)$/i.test(f))) return "ts";
  }
  const cwd = process.cwd();
  if (
    existsSync(join(cwd, "pyproject.toml")) ||
    existsSync(join(cwd, "pyrightconfig.json"))
  ) {
    return "py";
  }
  if (existsSync(join(cwd, "package.json"))) {
    return "ts";
  }
  return "ts";
}

function runCliCheck(
  cwd: string,
  language: "ts" | "vue" | "py",
  includeRuff: boolean | undefined,
  config: LanguageConfig | undefined,
): { items: CliDiagnostic[]; source: string } | { error: string } {
  if (language === "py") {
    // 配置桥接：编辑器设置与配置文件 key 不同名，这里做映射。
    // 优先级（与语言服务器一致）：项目配置文件 > 编辑器设置（仅当项目
    // 无配置文件时，才把编辑器设置里显式改过的值合成临时配置喂给 CLI）。
    const pyArgs = buildBasedpyrightArgs(cwd, config);
    const r = run(pyArgs.cmd, pyArgs.args, cwd);
    let all = parseBasedpyright(r.stdout);
    let source = "basedpyright";
    if (includeRuff !== false) {
      const ruff = resolveRuffCmd(cwd);
      if (ruff) {
        const rr = run(ruff.cmd, ruff.args, cwd);
        all = [...all, ...parseRuff(rr.stdout)];
        source = "basedpyright + ruff";
      }
    }
    return { items: all, source };
  }

  if (language === "vue") {
    const bin = resolveVueCmd(cwd);
    if (!bin) {
      return {
        error:
          "未找到 vue-tsc，请在项目内安装（vp install vue-tsc typescript@5.x）。注意：vp dlx 会误拉 TypeScript 7（Go 版）导致崩溃，须本地装并锁定 typescript 5.x。",
      };
    }
    const r = run(bin.cmd, bin.args, cwd);
    return {
      items: parseTscLines(r.stdout, "vue-tsc").filter((d) =>
        d.file.toLowerCase().endsWith(".vue"),
      ),
      source: "vue-tsc",
    };
  }

  const bin = resolveTsCmd(cwd);
  if (!bin) {
    return { error: "未找到 typescript，请在项目内安装（vp install typescript@5.x）" };
  }
  const r = run(bin.cmd, bin.args, cwd);
  return {
    items: parseTscLines(r.stdout, "tsc").filter(
      (d) => !d.file.toLowerCase().endsWith(".vue"),
    ),
    source: "tsc",
  };
}

function filterByFiles(
  items: CliDiagnostic[],
  files: string[] | undefined,
  cwd: string,
): CliDiagnostic[] {
  if (!files) return items;
  const wanted = new Set(
    files
      .map((f) => normPath(relative(cwd, f)))
      .filter((f) => f && !f.startsWith("..")),
  );
  const wantedAbs = new Set(files.map((f) => normPath(f)));
  return items.filter((d) => {
    const norm = normPath(d.file);
    return (
      wanted.has(norm) ||
      wantedAbs.has(norm) ||
      files.some((f) => norm.endsWith(normPath(f)) || normPath(f).endsWith(norm))
    );
  });
}

function mergeDiagnostics(
  cli: CliDiagnostic[],
  vscode: VscodeDiagnostic[],
  files: string[] | undefined,
  cwd: string,
): {
  merged: CliDiagnostic[];
  cliCount: number;
  vscodeMatched: number;
  vscodeUnique: number;
} {
  const seen = new Set<string>();
  const merged: CliDiagnostic[] = [];

  const vscodeFiltered = filterByFiles(vscode as CliDiagnostic[], files, cwd);

  // 先加 CLI（全量、权威），再加 VSCode 独有的（按 key 去重）
  for (const d of cli) {
    const k = diagKey(d, cwd);
    if (!seen.has(k)) {
      seen.add(k);
      merged.push(d);
    }
  }
  // vscodeMatched：范围内的全部 VSCode 诊断；vscodeUnique：去重后真正新增的
  let vscodeMatched = 0;
  let vscodeUnique = 0;
  for (const d of vscodeFiltered) {
    vscodeMatched += 1;
    const k = diagKey(d, cwd);
    if (!seen.has(k)) {
      seen.add(k);
      merged.push({
        ...d,
        code: "",
        message: d.message.split("\n")[0],
        source: d.source ?? "vscode",
      });
      vscodeUnique += 1;
    }
  }
  return { merged, cliCount: cli.length, vscodeMatched, vscodeUnique };
}

function displayPath(file: string, cwd: string): string {
  const rel = relative(cwd, file);
  return rel && !rel.startsWith("..") && !isAbsolute(rel)
    ? rel.replace(/\\/g, "/")
    : file.replace(/\\/g, "/");
}

function renderResult(args: {
  language: "ts" | "vue" | "py";
  cliSource: string;
  cliError?: string;
  cliCount: number;
  vscodeMatched: number;
  vscodeUnique: number;
  merged: CliDiagnostic[];
  files?: string[];
  vscodeTotal?: number;
}): string {
  const cwd = process.cwd();
  const lines: string[] = [];
  const filesStr = args.files?.length
    ? args.files.map((f) => displayPath(f, cwd)).join(", ")
    : "全项目";

  lines.push(
    `语言诊断（${args.language.toUpperCase()}，范围: ${filesStr}${
      args.cliSource ? `，CLI: ${args.cliSource}` : ""
    }）：`,
  );

  if (args.cliError) {
    lines.push("");
    lines.push(`⚠ CLI 检查失败：${args.cliError}`);
  }

  if (args.merged.length === 0) {
    lines.push("");
    lines.push("无诊断（CLI 与 VSCode 均未报告错误/警告）。");
    return lines.join("\n");
  }

  lines.push("");
  lines.push(
    `共 ${args.merged.length} 条（CLI ${args.cliCount} 条，VSCode 独有 ${args.vscodeUnique} 条，已去重）：`,
  );

  const byFile = new Map<string, CliDiagnostic[]>();
  for (const d of args.merged) {
    const f = displayPath(d.file, cwd);
    const list = byFile.get(f) ?? [];
    list.push(d);
    byFile.set(f, list);
  }
  for (const f of [...byFile.keys()].sort()) {
    const items = byFile.get(f)!;
    items.sort(
      (a, b) =>
        (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1) ||
        a.line - b.line,
    );
    lines.push("");
    lines.push(`### ${f}（${items.length} 条）`);
    for (const d of items) {
      const tag = d.source === "vscode"
        ? " [vscode]"
        : ` [${d.source}${d.code ? " " + d.code : ""}]`;
      lines.push(
        `${d.severity === "error" ? "✗" : "⚠"} ${d.line}:${d.col} ${d.message}${tag}`,
      );
    }
  }

  if (args.vscodeTotal != null && args.vscodeTotal > 0) {
    const dup = args.vscodeMatched - args.vscodeUnique;
    lines.push("");
    lines.push(
      `（VSCode 全工作区共 ${args.vscodeTotal} 条；本次范围内 ${args.vscodeMatched} 条，其中 ${dup} 条与 CLI 重复、${args.vscodeUnique} 条为 VSCode 独有）`,
    );
  }

  return lines.join("\n");
}