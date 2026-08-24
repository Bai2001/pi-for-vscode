// pi-for-vscode 工作区诊断工具（运行在终端的 pi 进程内）
// 读取 VSCode 扩展实时写入的 ~/.pi/agent/vscode-diagnostics.json，
// 注册 vscode_get_diagnostics 工具，让 agent 获取工作区错误/警告。
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

interface DiagnosticsFile {
  updatedAt: number;
  total: number;
  truncated: boolean;
  diagnostics: DiagnosticItem[];
}

// 与 VSCode 扩展一致的编码：cwd 非字母数字转 -，转小写
const DIAGNOSTICS_FILE = join(
  homedir(),
  ".pi",
  "agent",
  "vscode-ide",
  process.cwd().replace(/[^a-zA-Z0-9]/g, "-").toLowerCase(),
  "diagnostics.json",
);

function readDiagnostics(): DiagnosticsFile | undefined {
  try {
    return JSON.parse(readFileSync(DIAGNOSTICS_FILE, "utf8")) as DiagnosticsFile;
  } catch {
    return undefined;
  }
}

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "vscode_get_diagnostics",
    label: "获取 VSCode 工作区诊断",
    description:
      "获取 VSCode 当前工作区的诊断信息（TypeScript/ESLint 等扩展报告的错误与警告）。数据由 VSCode 扩展实时同步。可按严重级别与文件路径过滤。",
    promptSnippet: "获取 VSCode 工作区的错误与警告（诊断）",
    promptGuidelines: [
      "当用户提到编译错误、红线、lint 问题时，先用此工具获取当前诊断，而不是盲目搜索。",
    ],
    parameters: Type.Object({
      severity: Type.Optional(
        Type.Union([Type.Literal("error"), Type.Literal("warning"), Type.Literal("all")], {
          description: "严重级别过滤，默认 error",
        }),
      ),
      file: Type.Optional(Type.String({ description: "文件路径子串过滤（如 src/app）" })),
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
      let items = data.diagnostics;
      if (severity !== "all") items = items.filter((d) => d.severity === severity);
      if (params.file) items = items.filter((d) => d.file.includes(params.file as string));

      if (items.length === 0) {
        return {
          content: [{ type: "text", text: `没有匹配的${severity === "all" ? "诊断" : severity === "error" ? "错误" : "警告"}（工作区共 ${data.total} 条 error/warning）。` }],
          details: undefined,
        };
      }

      const lines = items.map((d) => `${d.severity === "error" ? "✗" : "⚠"} ${d.file}:${d.line}:${d.col} ${d.message}${d.source ? ` [${d.source}]` : ""}`);
      const header = `工作区诊断（共 ${data.total} 条${data.truncated ? "，已截断" : ""}，匹配 ${items.length} 条）：`;
      return {
        content: [{ type: "text", text: [header, ...lines].join("\n") }],
        details: { total: data.total, matched: items.length, truncated: data.truncated },
      };
    },
  });
}
