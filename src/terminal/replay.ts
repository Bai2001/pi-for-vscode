import { createRequire } from "node:module";
import type { SerializeAddon as SerializeAddonType } from "@xterm/addon-serialize";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";

export interface TerminalReplaySnapshot {
  data: string;
  sequence: number;
}

/**
 * 用 headless xterm 镜像 PTY 输出，关掉原生终端后仍能按有界 scrollback 重建画面
 * （光标、模式、颜色、备用屏、Kitty 键盘状态）。
 */
export class TerminalReplay {
  private readonly terminal: HeadlessTerminal;
  private readonly serializer: SerializeAddonType;
  private writeChain = Promise.resolve();
  private sequence = 0;
  private controlTail = "";
  private kittyKeyboardSequence = "";
  private disposed = false;

  constructor(cols = 80, rows = 24, scrollback = 1000) {
    const Terminal = loadHeadlessTerminal();
    const SerializeAddon = loadSerializeAddon();
    this.terminal = new Terminal({
      cols,
      rows,
      scrollback,
      allowProposedApi: true,
      vtExtensions: { kittyKeyboard: true },
    });
    this.serializer = new SerializeAddon();
    this.terminal.loadAddon(this.serializer as never);
  }

  write(data: string): number {
    if (this.disposed) return this.sequence;
    this.trackInputProtocol(data);
    const sequence = ++this.sequence;
    this.writeChain = this.writeChain.then(
      () =>
        new Promise<void>((resolve) => {
          if (this.disposed) return resolve();
          this.terminal.write(data, resolve);
        }),
    );
    return sequence;
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    this.writeChain = this.writeChain.then(() => {
      if (!this.disposed) this.terminal.resize(cols, rows);
    });
  }

  async snapshot(): Promise<TerminalReplaySnapshot> {
    if (this.disposed) return { data: "", sequence: this.sequence };
    for (;;) {
      const sequence = this.sequence;
      const writeChain = this.writeChain;
      await writeChain;
      if (this.disposed) return { data: "", sequence: this.sequence };
      if (sequence !== this.sequence || writeChain !== this.writeChain) continue;
      return { data: this.kittyKeyboardSequence + this.serializer.serialize(), sequence };
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.serializer.dispose();
    this.terminal.dispose();
  }

  private trackInputProtocol(data: string): void {
    const input = this.controlTail + data;
    for (const match of input.matchAll(/\x1b\[(?:>|<)[0-9:;]*u/g)) {
      this.kittyKeyboardSequence = match[0][2] === ">" ? match[0] : "";
    }
    this.controlTail = input.slice(-64);
  }
}

/**
 * Node 22 暴露 navigator，VSCode 还会包一层迁移警告。
 * xterm 的环境探测会把扩展宿主当成浏览器。加载 CommonJS 包期间先藏掉 navigator。
 */
function loadSerializeAddon(): typeof import("@xterm/addon-serialize").SerializeAddon {
  const require = createRequire(import.meta.url);
  return require("@xterm/addon-serialize")
    .SerializeAddon as typeof import("@xterm/addon-serialize").SerializeAddon;
}

function loadHeadlessTerminal(): typeof import("@xterm/headless").Terminal {
  const require = createRequire(import.meta.url);
  const host = globalThis as Record<string, unknown>;
  const descriptor = Object.getOwnPropertyDescriptor(host, "navigator");
  let replaced = false;
  try {
    if (!descriptor || descriptor.configurable) {
      Object.defineProperty(host, "navigator", {
        value: undefined,
        configurable: true,
        writable: true,
      });
      replaced = true;
    }
    return require("@xterm/headless").Terminal as typeof import("@xterm/headless").Terminal;
  } finally {
    if (replaced) {
      if (descriptor) Object.defineProperty(host, "navigator", descriptor);
      else delete host.navigator;
    }
  }
}
