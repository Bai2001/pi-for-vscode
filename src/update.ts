// 自动检查更新模块
// 职责：激活时/手动检查 GitHub Releases 是否有新版本，支持一键下载 VSIX 并安装。
import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

/** 扩展发布仓库（GitHub Releases 托管 VSIX） */
const REPO = "Bai2001/pi-for-vscode";
/** 网页端入口（不用 api.github.com：未认证请求限额仅 60 次/小时，易触发 403） */
const WEB_BASE = `https://github.com/${REPO}`;
/** 单次 HTTP 请求超时 */
const REQUEST_TIMEOUT_MS = 10_000;
/** GitHub API 要求带 User-Agent */
const USER_AGENT = "pi-for-vscode-updater";
/** 激活后延迟检查的时间（避免拖慢启动） */
const AUTO_CHECK_DELAY_MS = 5_000;

interface ReleaseInfo {
  /** 纯版本号（不含 v 前缀），如 0.4.0 */
  version: string;
  /** Release 页面地址 */
  htmlUrl: string;
  /** VSIX 资源下载地址（Release 未附带 VSIX 时为空） */
  vsixUrl?: string;
  /** VSIX 文件名 */
  vsixName?: string;
}

/**
 * 语义化版本比较：a > b 返回正数，a < b 返回负数，相等返回 0。
 * 无法解析的版本号一律视为相等（不提示更新，避免骚扰）。
 */
function compareVersions(a: string, b: string): number {
  const parse = (
    v: string,
  ): { nums: [number, number, number]; pre: string } | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v.trim());
    if (!m) return null;
    return {
      nums: [Number(m[1]), Number(m[2]), Number(m[3])],
      pre: m[4] ?? "",
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  }
  // 数字部分相同：无预发布后缀的更新（0.4.0 > 0.4.0-beta）
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre.localeCompare(pb.pre);
}

/** HTTPS GET（跟随重定向），返回响应体 Buffer。失败 reject。 */
function httpsGet(url: string, accept: string, redirects = 5): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: { "User-Agent": USER_AGENT, Accept: accept },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // GitHub 资源下载会 302 到 CDN，需要跟随
        if (
          status >= 300 &&
          status < 400 &&
          res.headers.location &&
          redirects > 0
        ) {
          res.resume();
          resolve(httpsGet(res.headers.location, accept, redirects - 1));
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
  });
}

/**
 * 拉取最新发布信息。
 * 两个频道都走 releases.atom（实时、无 CDN 缓存）；/releases/latest 的重定向在发布后有数分钟缓存不一致。
 * stable：取第一个不带预发布后缀（-beta/-alpha 等）的 tag；
 * prerelease：直接取第一条 entry（可能含预发布）。
 * VSIX 下载地址按 CI 打包规则拼接（pi-for-vscode-<version>.vsix）。
 */
async function fetchLatestRelease(
  channel: string,
): Promise<ReleaseInfo | null> {
  const body = await httpsGet(
    `${WEB_BASE}/releases.atom`,
    "application/atom+xml",
  );
  const text = body.toString("utf8");
  // atom 按发布时间倒序，每个 entry 内含 /releases/tag/<tag> 链接
  const tags = [
    ...text.matchAll(/<entry>[\s\S]*?\/releases\/tag\/([^"<]+)"/g),
  ].map((m) => m[1]);
  if (tags.length === 0) return null;

  let tag: string | undefined;
  if (channel === "prerelease") {
    tag = tags[0];
  } else {
    // stable：跳过带预发布后缀的 tag（如 v0.5.1-beta）
    tag = tags.find((t) => !/^v?\d+\.\d+\.\d+-/.test(t));
  }
  if (!tag) return null;
  tag = decodeURIComponent(tag);
  const version = tag.replace(/^v/, "");
  return {
    version,
    htmlUrl: `${WEB_BASE}/releases/tag/${tag}`,
    vsixUrl: `${WEB_BASE}/releases/download/${tag}/pi-for-vscode-${version}.vsix`,
    vsixName: `pi-for-vscode-${version}.vsix`,
  };
}

/** 下载 VSIX 到临时目录（带进度通知），返回本地路径 */
async function downloadVsix(release: ReleaseInfo): Promise<string> {
  if (!release.vsixUrl || !release.vsixName)
    throw new Error("Release 未附带 VSIX 文件");
  const target = path.join(os.tmpdir(), release.vsixName);
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `正在下载 pi-for-vscode v${release.version}…`,
    },
    async () => {
      const buf = await httpsGet(release.vsixUrl!, "application/octet-stream");
      await fs.promises.writeFile(target, buf);
      return target;
    },
  );
}

/** 一键更新：下载 VSIX 并调用内置命令安装 */
async function downloadAndInstall(release: ReleaseInfo): Promise<void> {
  try {
    const vsixPath = await downloadVsix(release);
    await vscode.commands.executeCommand(
      "workbench.extensions.installExtension",
      vscode.Uri.file(vsixPath),
    );
    const reload = "立即重启";
    const pick = await vscode.window.showInformationMessage(
      `pi-for-vscode v${release.version} 安装完成，重启 VSCode 后生效。`,
      reload,
    );
    if (pick === reload) {
      void vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  } catch (err) {
    const openPage = "前往下载页";
    const pick = await vscode.window.showWarningMessage(
      `自动更新失败（${err instanceof Error ? err.message : String(err)}），可手动下载安装。`,
      openPage,
    );
    if (pick === openPage) {
      void vscode.env.openExternal(vscode.Uri.parse(release.htmlUrl));
    }
  }
}

/**
 * 检查更新主流程。
 * manual=true（手动命令）时无论结果都给出反馈；自动触发时失败与无更新均静默。
 */
async function checkForUpdate(
  context: vscode.ExtensionContext,
  manual: boolean,
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("pi-for-vscode");
  if (!manual && !cfg.get<boolean>("update.enabled", true)) return;
  const channel = cfg.get<string>("update.channel", "stable");
  const current: string = context.extension.packageJSON.version;

  let release: ReleaseInfo | null;
  try {
    release = await fetchLatestRelease(channel);
  } catch (err) {
    if (manual) {
      void vscode.window.showWarningMessage(
        `检查更新失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }
  if (!release) {
    if (manual)
      void vscode.window.showInformationMessage(
        "检查更新失败：未找到发布信息。",
      );
    return;
  }
  if (compareVersions(release.version, current) <= 0) {
    if (manual)
      void vscode.window.showInformationMessage(
        `当前已是最新版本 v${current}。`,
      );
    return;
  }

  const updateNow = "立即更新";
  const openPage = "前往下载页";
  const ignore = "忽略";
  const pick = await vscode.window.showInformationMessage(
    `发现 pi-for-vscode 新版本 v${release.version}（当前 v${current}）。`,
    updateNow,
    openPage,
    ignore,
  );
  if (pick === updateNow) {
    await downloadAndInstall(release);
  } else if (pick === openPage) {
    void vscode.env.openExternal(vscode.Uri.parse(release.htmlUrl));
  }
}

/** 注册更新功能：手动命令 + 激活后延迟自动检查一次 */
export function registerUpdateChecker(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "pi-for-vscode.checkUpdate",
      () => void checkForUpdate(context, true),
    ),
  );

  if (
    vscode.workspace
      .getConfiguration("pi-for-vscode")
      .get<boolean>("update.enabled", true)
  ) {
    const timer = setTimeout(
      () => void checkForUpdate(context, false),
      AUTO_CHECK_DELAY_MS,
    );
    context.subscriptions.push({ dispose: () => clearTimeout(timer) });
  }
}
