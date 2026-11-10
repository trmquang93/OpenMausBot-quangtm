// What a terminal session starts with: which shell, in which folder, with which environment.
import { accessSync, constants, existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { TERMINAL_MESSAGES } from "../../shared/terminal.ts";

const UNIX_ALLOWED = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "TMPDIR", "ZDOTDIR", "XDG_CONFIG_HOME"];
const WINDOWS_ALLOWED = [
  "PATH", "PATHEXT", "USERNAME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC",
  "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "TEMP", "TMP", "COMPUTERNAME",
  "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "LANG", "TERM",
];

/** The environment a terminal gets: an allowlist, so the server's own tokens, API keys and SSH agent never reach a program. */
export function scrubEnv(source: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const allowed = new Set(platform === "win32" ? WINDOWS_ALLOWED : UNIX_ALLOWED);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const key = platform === "win32" ? name.toUpperCase() : name;
    if (allowed.has(key) || (platform !== "win32" && key.startsWith("LC_"))) env[name] = value;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.TERM_PROGRAM = "OpenMausBot";
  return env;
}

const sameFolder = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return sameFolder(rel, "") || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export type CwdResult = { ok: true; cwd: string } | { ok: false; error: string };

/** The folder a terminal starts in. A requested one must lie inside an allowed root, by name and after symlinks. */
export function resolveCwd(requested: string | undefined, roots: readonly string[], defaultCwd: string): CwdResult {
  const base = defaultCwd;
  let target = base;
  if (requested !== undefined && requested.trim() !== "") {
    if (requested.split(/[\\/]+/).includes("..")) return { ok: false, error: TERMINAL_MESSAGES.cwdOutside };
    target = resolve(base, requested.trim());
    if (!roots.some((root) => inside(target, resolve(root)))) return { ok: false, error: TERMINAL_MESSAGES.cwdOutside };
  }
  let real: string;
  try { real = realpathSync(target); }
  catch { return { ok: false, error: TERMINAL_MESSAGES.cwdMissing }; }
  if (!statSync(real).isDirectory()) return { ok: false, error: TERMINAL_MESSAGES.cwdMissing };
  if (target !== base || requested !== undefined) {
    const realRoots = roots.flatMap((root) => { try { return [realpathSync(root)]; } catch { return []; } });
    if (!realRoots.some((root) => inside(real, root))) return { ok: false, error: TERMINAL_MESSAGES.cwdOutside };
  }
  return { ok: true, cwd: real };
}

const SHELL_NAMES = ["zsh", "bash", "fish", "sh", "pwsh", "powershell", "cmd"] as const;
type ShellName = (typeof SHELL_NAMES)[number];
const UNIX_SHELL_DIRS = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];

function executable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
}

export interface ShellChoice {
  file: string;
  name: string;
}

/** `requested` is a shell's name from a short list; without it, the person's own login shell. */
export function chooseShell(requested: string | undefined, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ShellChoice | null {
  if (requested !== undefined && requested !== "") {
    const name = requested.replace(/\.exe$/i, "").toLowerCase() as ShellName;
    if (!SHELL_NAMES.includes(name)) return null;
    if (platform === "win32") return name === "pwsh" || name === "powershell" || name === "cmd" ? { file: `${name}.exe`, name } : null;
    for (const dir of UNIX_SHELL_DIRS) if (executable(join(dir, name))) return { file: join(dir, name), name };
    return null;
  }
  if (platform === "win32") return { file: env.COMSPEC && existsSync(env.COMSPEC) ? env.COMSPEC : "powershell.exe", name: env.COMSPEC ? "cmd" : "powershell" };
  const own = env.SHELL;
  if (own && isAbsolute(own) && executable(own)) return { file: own, name: basename(own) };
  for (const fallback of platform === "darwin" ? ["zsh", "bash", "sh"] : ["bash", "sh"]) {
    for (const dir of UNIX_SHELL_DIRS) if (executable(join(dir, fallback))) return { file: join(dir, fallback), name: fallback };
  }
  return null;
}

/** Where the OSC 133 scripts are: beside this file in a checkout, under terminal/ beside the server bundle when packaged. */
export function shellIntegrationDirectory(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, "shell-integration"), join(here, "terminal", "shell-integration")]) {
    if (existsSync(join(candidate, "zsh.sh"))) return candidate;
  }
  return null;
}

export interface ShellLaunch {
  args: string[];
  env: Record<string, string>;
  /** Whether the shell was started with OSC 133 prompt marks. */
  integrated: boolean;
  /** A temporary folder holding the rc files this launch sourced; the session removes it when it ends. */
  cleanup: string | null;
}

const ZSH_FILES = {
  ".zshenv": '[ -f "$OMB_USER_ZDOTDIR/.zshenv" ] && { ZDOTDIR="$OMB_USER_ZDOTDIR"; . "$OMB_USER_ZDOTDIR/.zshenv"; ZDOTDIR="$OMB_TERMINAL_RC"; }\n',
  ".zprofile": '[ -f "$OMB_USER_ZDOTDIR/.zprofile" ] && { ZDOTDIR="$OMB_USER_ZDOTDIR"; . "$OMB_USER_ZDOTDIR/.zprofile"; ZDOTDIR="$OMB_TERMINAL_RC"; }\n',
  ".zshrc": 'ZDOTDIR="$OMB_USER_ZDOTDIR"\n[ -f "$OMB_USER_ZDOTDIR/.zshrc" ] && . "$OMB_USER_ZDOTDIR/.zshrc"\n. "$OMB_INTEGRATION_DIR/zsh.sh"\nunset OMB_USER_ZDOTDIR OMB_TERMINAL_RC OMB_INTEGRATION_DIR\n',
};

const BASH_INIT = [
  'if [ -n "$OMB_SHELL_LOGIN" ]; then',
  '  [ -r /etc/profile ] && . /etc/profile',
  '  for f in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do [ -r "$f" ] && { . "$f"; break; }; done',
  'else',
  '  [ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc"',
  'fi',
  '. "$OMB_INTEGRATION_DIR/bash.sh"',
  'unset OMB_SHELL_LOGIN OMB_INTEGRATION_DIR',
  "",
].join("\n");

/** Arguments and extra environment for `shell`, with OSC 133 prompt marks sourced from a temporary rc when `integrate`. */
export function shellLaunch(shell: ShellChoice, env: Record<string, string>, integrate: boolean, platform: NodeJS.Platform = process.platform): ShellLaunch {
  if (platform === "win32") return { args: shell.name === "cmd" ? [] : ["-NoLogo"], env, integrated: false, cleanup: null };
  const directory = integrate ? shellIntegrationDirectory() : null;
  if (!directory || !["zsh", "bash", "fish"].includes(shell.name)) return { args: shell.name === "sh" ? [] : ["-l"], env, integrated: false, cleanup: null };
  if (shell.name === "fish") {
    return { args: ["-l", "--init-command", `source ${JSON.stringify(join(directory, "fish.fish"))}`], env, integrated: true, cleanup: null };
  }
  const temp = mkdtempSync(join(tmpdir(), "omb-terminal-"));
  if (shell.name === "zsh") {
    for (const [file, text] of Object.entries(ZSH_FILES)) writeFileSync(join(temp, file), text, { mode: 0o600 });
    return {
      args: ["-l"],
      env: { ...env, ZDOTDIR: temp, OMB_TERMINAL_RC: temp, OMB_USER_ZDOTDIR: env.ZDOTDIR || env.HOME || homedir(), OMB_INTEGRATION_DIR: directory },
      integrated: true,
      cleanup: temp,
    };
  }
  const init = join(temp, "bash-init.sh");
  writeFileSync(init, BASH_INIT, { mode: 0o600 });
  return { args: ["--init-file", init], env: { ...env, OMB_SHELL_LOGIN: "1", OMB_INTEGRATION_DIR: directory }, integrated: true, cleanup: temp };
}

export function removeLaunchFiles(cleanup: string | null): void {
  if (cleanup) rmSync(cleanup, { recursive: true, force: true });
}
