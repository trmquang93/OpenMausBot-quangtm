// A PTY the tests drive by hand: it records what the session sends and prints what the test says.
import type { PtyExit, PtyProcess, PtySpawner, PtySpawnOptions } from "./pty.ts";

export class FakePty implements PtyProcess {
  readonly pid = 4242;
  readonly written: string[] = [];
  readonly resized: Array<[number, number]> = [];
  readonly signals: Array<NodeJS.Signals | undefined> = [];
  private readonly dataListeners: Array<(data: string) => void> = [];
  private readonly exitListeners: Array<(exit: PtyExit) => void> = [];
  readonly options: PtySpawnOptions;

  constructor(options: PtySpawnOptions) {
    this.options = options;
  }

  onData(listener: (data: string) => void): void { this.dataListeners.push(listener); }
  onExit(listener: (exit: PtyExit) => void): void { this.exitListeners.push(listener); }
  write(data: string): void { this.written.push(data); }
  resize(cols: number, rows: number): void { this.resized.push([cols, rows]); }
  kill(signal?: NodeJS.Signals): void { this.signals.push(signal); }

  print(data: string): void { for (const listener of this.dataListeners) listener(data); }
  end(exitCode: number, signal?: number): void { for (const listener of this.exitListeners) listener({ exitCode, ...(signal ? { signal } : {}) }); }
}

export function fakeSpawner(): { spawn: PtySpawner; ptys: FakePty[] } {
  const ptys: FakePty[] = [];
  return { ptys, spawn: (options) => { const pty = new FakePty(options); ptys.push(pty); return pty; } };
}
