/**
 * Windows ConPTY 会吞掉备用屏里的鼠标跟踪 / 关闭自动换行序列（实验：?1000h/?1002h/?1006h/?7l 出不了 pty）。
 * VS Code xterm 因此以为应用不要鼠标，在无 scrollback 的备用屏把滚轮转成 ↑/↓，
 * pi 全屏 TUI 就把它当成切换输入历史。SGR 鼠标输入仍能穿过 ConPTY，所以把被剥掉的
 * 序列补回给 VS Code 终端即可。
 */
export const ENTER_ALT_SCREEN = "\x1b[?1049h";
export const EXIT_ALT_SCREEN = "\x1b[?1049l";
export const RESTORED_ON_ENTER = "\x1b[?7l\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h";
export const RESTORED_ON_EXIT = "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?7h";

const MAX_PARTIAL = ENTER_ALT_SCREEN.length - 1;

export class ConptyMouseRestorer {
  private tail = "";
  private readonly enabled: boolean;

  constructor(enabled = process.platform === "win32") {
    this.enabled = enabled;
  }

  reset(): void {
    this.tail = "";
  }

  feed(data: string): string {
    if (!this.enabled || !data) return data;
    const input = this.tail + data;
    this.tail = partialAltScreenSuffix(input);
    const complete = this.tail ? input.slice(0, -this.tail.length) : input;
    if (!complete) return "";
    return complete
      .replaceAll(ENTER_ALT_SCREEN, ENTER_ALT_SCREEN + RESTORED_ON_ENTER)
      .replaceAll(EXIT_ALT_SCREEN, EXIT_ALT_SCREEN + RESTORED_ON_EXIT);
  }
}

function partialAltScreenSuffix(value: string): string {
  const limit = Math.min(MAX_PARTIAL, value.length);
  for (let n = limit; n > 0; n--) {
    const suffix = value.slice(-n);
    if (ENTER_ALT_SCREEN.startsWith(suffix) || EXIT_ALT_SCREEN.startsWith(suffix)) return suffix;
  }
  return "";
}
