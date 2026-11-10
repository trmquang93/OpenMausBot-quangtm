// The only module that touches node-pty. It is a native module, so the packaged app stages it outside the bundle
// (scripts/prepare-node-pty.mjs) and the server loads it from there, as server/data/engine.ts does for DuckDB.
import { accessSync, chmodSync, constants, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export interface PtyExit {
  exitCode: number;
  signal?: number;
}

export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (exit: PtyExit) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: NodeJS.Signals): void;
}

export interface PtySpawnOptions {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export type PtySpawner = (options: PtySpawnOptions) => PtyProcess;

type NodePty = typeof import("node-pty");

/** Null means the server's own node_modules. */
export function nodePtyDirectory(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.OMB_NODE_PTY_DIR) return env.OMB_NODE_PTY_DIR;
  if (env.OMB_RESOURCES_PATH) {
    const staged = join(env.OMB_RESOURCES_PATH, "node-pty");
    if (existsSync(staged)) return staged;
  }
  return null;
}

let loaded: { module: NodePty; require: NodeJS.Require } | undefined;

function load(env: NodeJS.ProcessEnv): { module: NodePty; require: NodeJS.Require } {
  if (loaded) return loaded;
  const directory = nodePtyDirectory(env);
  const require = createRequire(directory ? join(directory, "node_modules", "openmausbot-node-pty-anchor.js") : import.meta.url);
  loaded = { module: require("node-pty") as NodePty, require };
  return loaded;
}

/** node-pty 1.1.0 publishes its macOS spawn-helper without the executable bit, and posix_spawnp then fails. */
function makeHelperExecutable(require: NodeJS.Require): void {
  if (process.platform === "win32") return;
  let root: string;
  try { root = dirname(require.resolve("node-pty/package.json")); } catch { return; }
  for (const helper of [join(root, "build", "Release", "spawn-helper"), join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper")]) {
    try {
      if (!statSync(helper).isFile()) continue;
      accessSync(helper, constants.X_OK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      try { chmodSync(helper, 0o755); } catch { /* spawn reports the failure */ }
    }
  }
}

export const spawnPty: PtySpawner = (options) => {
  const { module, require } = load(process.env);
  makeHelperExecutable(require);
  const pty = module.spawn(options.file, options.args, {
    name: options.env.TERM ?? "xterm-256color",
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
  });
  return {
    pid: pty.pid,
    onData: (listener) => { pty.onData(listener); },
    onExit: (listener) => { pty.onExit((exit) => listener({ exitCode: exit.exitCode, ...(exit.signal ? { signal: exit.signal } : {}) })); },
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    kill: (signal) => {
      try { if (process.platform === "win32") pty.kill(); else pty.kill(signal); }
      catch { /* already gone */ }
    },
  };
};
