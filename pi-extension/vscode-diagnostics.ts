// pi-for-vscode 工作区诊断工具（运行在终端的 pi 进程内）
// 读取 VSCode 扩展实时写入的 ~/.pi/agent/vscode-ide/<key>/diagnostics.json，
// 注册 vscode_get_diagnostics 工具，让 agent 获取工作区错误/警告。
// 多根工作区：诊断按根分组存储，支持按根名/路径子串过滤。
//
// diagnose 模式：部分语言扩展（如 Vue/Volar）只诊断「已打开」的文档，未打开
// 文件永远查不到诊断。该模式把文件列表写进 diagnostics-request.json，请求
// VSCode 扩展打开这些文件并等诊断完成，再从 diagnostics-response.json 读取
// 每个文件的状态与诊断（干净文件不会出现在 diagnostics.json 里，响应文件
// 才能区分「已分析无错」和「没分析」）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface DiagnosticItem {
  file: string;
  line: number;
  col: number;
  severity: "error" | "warning";
  message: string;
  source?: string;
}

interface RootDiagnostics {
  /** 根目录绝对路径 */
  root: string;
  /** 根目录显示名 */
  rootName: string;
  diagnostics: DiagnosticItem[];
}

interface DiagnosticsFile {
  updatedAt: number;
  total: number;
  truncated: boolean;
  roots: RootDiagnostics[];
}

/** 旧格式（v0.4.x 及以前）：诊断平铺在 diagnostics 字段，无根分组 */
interface LegacyDiagnosticsFile {
  updatedAt: number;
  total: number;
  truncated: boolean;
  diagnostics: DiagnosticItem[];
}

interface DiagnoseItem {
  line: number;
  col: number;
  severity: "error" | "warning";
  message: string;
  source?: string;
}

interface DiagnoseFileResult {
  /** 绝对路径 */
  file: string;
  /** analyzed=收到过诊断信号；uncertain=等满超时仍无信号；not-found=文件打不开 */
  status: "analyzed" | "uncertain" | "not-found";
  items: DiagnoseItem[];
}

interface DiagnoseResponse {
  id: string;
  openMode: "headless" | "visible";
  files: DiagnoseFileResult[];
}

// 与 VSCode 扩展一致的编码：cwd 非字母数字转 -，转小写。
// pi 进程 cwd = 终端启动目录 = VSCode 工作区第一个根，同一窗口的 pi 进程共享同一目录。
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
const DIAGNOSTICS_REQUEST_FILE = join(IDE_DIR, "diagnostics-request.json");
const DIAGNOSTICS_RESPONSE_FILE = join(IDE_DIR, "diagnostics-response.json");

/** diagnose 模式等待 VSCode 扩展响应的总超时（扩展侧最长等待 15s + 处理开销） */
const RESPONSE_TIMEOUT_MS = 25_000;
const POLL_INTERVAL_MS = 300;
/** 单次最多请求诊断的文件数（与 VSCode 扩展侧上限一致） */
const MAX_DIAGNOSE_FILES = 50;

/**
 * 读取诊断文件。兼容旧格式：旧格式没有 roots 字段（诊断平铺在 diagnostics），
 * 包成单个「未知根」分组，保证旧扩展 + 新 pi 端组合不报错。
 */
function readDiagnostics(): DiagnosticsFile | undefined {
  try {
    const raw = JSON.parse(
      readFileSync(DIAGNOSTICS_FILE, "utf8"),
    ) as DiagnosticsFile | LegacyDiagnosticsFile;
    if (Array.isArray((raw as DiagnosticsFile).roots)) {
      return raw as DiagnosticsFile;
    }
    if (Array.isArray((raw as LegacyDiagnosticsFile).diagnostics)) {
      const legacy = raw as LegacyDiagnosticsFile;
      return {
        updatedAt: legacy.updatedAt,
        total: legacy.total,
        truncated: legacy.truncated,
        roots: [
          {
            root: process.cwd(),
            rootName: "工作区",
            diagnostics: legacy.diagnostics,
          },
        ],
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 读取诊断响应。写入中被读到（JSON 不完整）或旧请求的响应都返回 undefined，下一轮再试。 */
function readDiagnoseResponse(): DiagnoseResponse | undefined {
  try {
    const raw = JSON.parse(
      readFileSync(DIAGNOSTICS_RESPONSE_FILE, "utf8"),
    ) as DiagnoseResponse;
    if (typeof raw?.id === "string" && Array.isArray(raw.files)) return raw;
  } catch {
    /* 未就绪 */
  }
  return undefined;
}

/** 写请求文件并轮询响应（匹配本次请求 id），超时返回 undefined */
async function requestDiagnostics(
  files: string[],
): Promise<DiagnoseResponse | undefined> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    mkdirSync(IDE_DIR, { recursive: true });
    writeFileSync(DIAGNOSTICS_REQUEST_FILE, JSON.stringify({ id, files }));
  } catch {
    return undefined;
  }
  const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const res = readDiagnoseResponse();
    if (res && res.id === id) return res;
  }
  return undefined;
}

/** 显示路径：cwd 内显示相对路径，否则绝对路径 */
function displayPath(file: string): string {
  const rel = relative(process.cwd(), file);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : file;
}

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "vscode_get_diagnostics",
    label: "获取 VSCode 工作区诊断",
    description:
      "获取 VSCode 当前工作区的诊断信息（TypeScript/ESLint 等扩展报告的错误与警告）。多根工作区下诊断按根目录分组。数据由 VSCode 扩展实时同步。可按严重级别、文件路径、根目录过滤。部分语言扩展只诊断「已打开」的文件：检查未打开的文件（如刚创建/刚修改的）时，用 diagnose 参数传入文件路径，工具会请求 VSCode 打开并等待分析完成后返回。",
    promptSnippet: "获取 VSCode 工作区的错误与警告（诊断）",
    promptGuidelines: [
      "当用户提到编译错误、红线、lint 问题时，先用此工具获取当前诊断，而不是盲目搜索。",
      "多根工作区下，诊断按根目录分组展示；如需聚焦某根，用 root 参数过滤。",
      "检查未打开文件（如刚创建/刚修改的文件）的诊断时，用 diagnose 参数传文件路径（支持数组）；不带该参数只读取已收集的诊断（快，但未打开文件可能缺失）。",
    ],
    parameters: Type.Object({
      severity: Type.Optional(
        Type.Union(
          [Type.Literal("error"), Type.Literal("warning"), Type.Literal("all")],
          {
            description: "严重级别过滤，默认 error",
          },
        ),
      ),
      file: Type.Optional(
        Type.String({ description: "文件路径子串过滤（如 src/app）" }),
      ),
      root: Type.Optional(
        Type.String({ description: "根目录名或路径子串过滤（如 backend）" }),
      ),
      diagnose: Type.Optional(
        Type.Union([Type.String(), Type.Array(Type.String())], {
          description:
            "需要诊断的文件路径（相对 cwd 或绝对路径，支持单个或数组）。用于获取未打开文件的诊断：请求 VSCode 打开这些文件并等待分析完成。新文件/已打开文件均可。",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      // diagnose 模式：请求 -> 等待 -> 按文件返回
      if (params.diagnose) {
        return await executeDiagnose(params);
      }

      const data = readDiagnostics();
      if (!data) {
        throw new Error(
          "无法读取 VSCode 诊断数据（VSCode 扩展未运行或尚未写入）。请确认 pi-for-vscode 扩展已在 VSCode 中激活。",
        );
      }

      const severity = params.severity ?? "error";
      let roots = data.roots;
      if (params.root) {
        const needle = (params.root as string).toLowerCase();
        roots = roots.filter(
          (r) =>
            r.rootName.toLowerCase().includes(needle) ||
            r.root.toLowerCase().includes(needle),
        );
      }

      const groups = roots
        .map((r) => {
          let items = r.diagnostics;
          if (severity !== "all")
            items = items.filter((d) => d.severity === severity);
          if (params.file)
            items = items.filter((d) => d.file.includes(params.file as string));
          return { rootName: r.rootName, root: r.root, items };
        })
        .filter((g) => g.items.length > 0);

      const matched = groups.reduce((n, g) => n + g.items.length, 0);
      if (matched === 0) {
        return {
          content: [
            {
              type: "text",
              text: `没有匹配的${severity === "all" ? "诊断" : severity === "error" ? "错误" : "警告"}（工作区共 ${data.total} 条 error/warning）。注意：部分语言扩展只诊断已打开的文件，未打开文件可能缺失；如需检查特定文件，用 diagnose 参数传入文件路径。`,
            },
          ],
          details: undefined,
        };
      }

      const lines: string[] = [];
      const header = `工作区诊断（共 ${data.total} 条${data.truncated ? "，已截断" : ""}，匹配 ${matched} 条，分布在 ${groups.length} 个根目录）：`;
      lines.push(header);
      for (const g of groups) {
        lines.push("");
        lines.push(`### ${g.rootName} (${g.root})`);
        for (const d of g.items) {
          lines.push(
            `${d.severity === "error" ? "✗" : "⚠"} ${d.file}:${d.line}:${d.col} ${d.message}${d.source ? ` [${d.source}]` : ""}`,
          );
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          total: data.total,
          matched,
          truncated: data.truncated,
          rootCount: groups.length,
        },
      };
    },
  });
}

/** diagnose 模式的执行逻辑 */
async function executeDiagnose(params: {
  diagnose?: string | string[];
  severity?: "error" | "warning" | "all";
}): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
}> {
  const raw = Array.isArray(params.diagnose)
    ? params.diagnose
    : [params.diagnose ?? ""];
  const truncated = raw.length > MAX_DIAGNOSE_FILES;
  const files = raw
    .map((p) => resolve(process.cwd(), p))
    .slice(0, MAX_DIAGNOSE_FILES);

  if (files.length === 0) {
    throw new Error("diagnose 参数为空，请传入至少一个文件路径。");
  }
  const missing = files.filter((f) => !existsSync(f));
  if (missing.length > 0) {
    throw new Error(
      `以下文件不存在，无法请求诊断：\n${missing.map(displayPath).join("\n")}`,
    );
  }

  const res = await requestDiagnostics(files);
  if (!res) {
    throw new Error(
      `VSCode 扩展 ${RESPONSE_TIMEOUT_MS / 1000}s 内未响应诊断请求。可能原因：扩展未激活、版本过旧（不支持 diagnose 参数，请更新 pi-for-vscode）、或语言服务卡死。可重载 VSCode 窗口后重试；临时方案：不带 diagnose 参数读取已收集的诊断。`,
    );
  }

  const severity = params.severity ?? "error";
  const lines: string[] = [];
  lines.push(
    `诊断完成（${files.length} 个文件${truncated ? `，已截断（上限 ${MAX_DIAGNOSE_FILES}）` : ""}，打开模式 ${res.openMode}，severity ${severity}）：`,
  );
  let analyzed = 0;
  let uncertain = 0;
  let notFound = 0;
  let matched = 0;
  const uncertainFiles: string[] = [];

  for (const f of res.files) {
    lines.push("");
    lines.push(`### ${displayPath(f.file)}`);
    if (f.status === "not-found") {
      notFound += 1;
      lines.push("文件无法打开（已不存在或不可读）。");
      continue;
    }
    if (f.status === "uncertain") {
      uncertain += 1;
      uncertainFiles.push(displayPath(f.file));
      lines.push(
        "未收到诊断信号：文件已打开，但等待期间没有语言扩展发布诊断。可能确实无错误，也可能该语言扩展不支持后台分析（详见下方提示）。",
      );
      continue;
    }
    analyzed += 1;
    const items =
      severity === "all"
        ? f.items
        : f.items.filter((d) => d.severity === severity);
    matched += items.length;
    if (items.length === 0) {
      lines.push(
        severity === "all"
          ? "已分析，无诊断。"
          : `已分析，无${severity === "error" ? "错误" : "警告"}。`,
      );
      continue;
    }
    lines.push(`已分析，${items.length} 条：`);
    for (const d of items) {
      lines.push(
        `${d.severity === "error" ? "✗" : "⚠"} ${d.line}:${d.col} ${d.message}${d.source ? ` [${d.source}]` : ""}`,
      );
    }
  }

  if (uncertainFiles.length > 0) {
    lines.push("");
    lines.push(
      `提示：${uncertainFiles.join("、")} 未收到诊断信号。若需可靠结果：在 VSCode 设置中把 pi-for-vscode.diagnostics.openMode 改为 visible 后重试，或让用户在编辑器中打开该文件。`,
    );
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: {
      requested: files.length,
      analyzed,
      uncertain,
      notFound,
      matched,
      openMode: res.openMode,
    },
  };
}
