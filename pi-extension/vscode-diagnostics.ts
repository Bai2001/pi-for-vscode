// pi-for-vscode 工作区诊断工具（运行在终端的 pi 进程内）
// 经 named pipe 向 VSCode 宿主查询诊断（JSON 文件仅宿主调试落盘，此处不读）。
// 多根工作区：诊断按根分组，支持按根名/路径子串过滤。
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { callIpcData } from "./vscode-ipc";

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

async function fetchDiagnostics(): Promise<DiagnosticsFile | undefined> {
  try {
    const raw = await callIpcData<DiagnosticsFile>("get_diagnostics");
    if (raw && Array.isArray(raw.roots)) return raw;
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
        Type.Union([Type.Literal("error"), Type.Literal("warning"), Type.Literal("all")], {
          description: "严重级别过滤，默认 error",
        }),
      ),
      file: Type.Optional(Type.String({ description: "文件路径子串过滤（如 src/app）" })),
      root: Type.Optional(Type.String({ description: "根目录名或路径子串过滤（如 backend）" })),
    }),
    async execute(_toolCallId, params) {
      const data = await fetchDiagnostics();
      if (!data) {
        // 报错用 throw：execute return 里的 isError 会被运行时忽略（pi 文档明确）
        throw new Error(
          "无法获取 VSCode 诊断数据。请用扩展命令「pi：打开终端会话」启动 pi，并确认 pi-for-vscode 已激活。",
        );
      }

      const severity = params.severity ?? "error";
      let roots = data.roots;
      if (params.root) {
        const needle = (params.root as string).toLowerCase();
        roots = roots.filter(
          (r) => r.rootName.toLowerCase().includes(needle) || r.root.toLowerCase().includes(needle),
        );
      }

      const groups = roots
        .map((r) => {
          let items = r.diagnostics;
          if (severity !== "all") items = items.filter((d) => d.severity === severity);
          if (params.file) items = items.filter((d) => d.file.includes(params.file as string));
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
