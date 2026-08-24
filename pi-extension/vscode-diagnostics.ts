// pi-for-vscode 工作区诊断工具（运行在终端的 pi 进程内）
// 读取 VSCode 扩展实时写入的 ~/.pi/agent/vscode-ide/<key>/diagnostics.json，
// 注册 vscode_get_diagnostics 工具，让 agent 获取工作区错误/警告。
// 多根工作区：诊断按根分组存储，支持按根名/路径子串过滤。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

// 与 VSCode 扩展一致的编码：cwd 非字母数字转 -，转小写。
// pi 进程 cwd = 终端启动目录 = VSCode 工作区第一个根，同一窗口的 pi 进程共享同一目录。
const DIAGNOSTICS_FILE = join(
  homedir(),
  ".pi",
  "agent",
  "vscode-ide",
  process
    .cwd()
    .replace(/[^a-zA-Z0-9]/g, "-")
    .toLowerCase(),
  "diagnostics.json",
);

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

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "vscode_get_diagnostics",
    label: "获取 VSCode 工作区诊断",
    description:
      "获取 VSCode 当前工作区的诊断信息（TypeScript/ESLint 等扩展报告的错误与警告）。多根工作区下诊断按根目录分组。数据由 VSCode 扩展实时同步。可按严重级别、文件路径、根目录过滤。",
    promptSnippet: "获取 VSCode 工作区的错误与警告（诊断）",
    promptGuidelines: [
      "当用户提到编译错误、红线、lint 问题时，先用此工具获取当前诊断，而不是盲目搜索。",
      "多根工作区下，诊断按根目录分组展示；如需聚焦某根，用 root 参数过滤。",
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
    }),
    async execute(_toolCallId, params) {
      const data = readDiagnostics();
      if (!data) {
        return {
          content: [
            {
              type: "text",
              text: "无法读取 VSCode 诊断数据（VSCode 扩展未运行或尚未写入）。请确认 pi-for-vscode 扩展已在 VSCode 中激活。",
            },
          ],
          details: undefined,
          isError: true,
        };
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
              text: `没有匹配的${severity === "all" ? "诊断" : severity === "error" ? "错误" : "警告"}（工作区共 ${data.total} 条 error/warning）。`,
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
