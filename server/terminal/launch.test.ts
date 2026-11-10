import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const posix = process.platform !== "win32";

import { TERMINAL_MESSAGES } from "../../shared/terminal.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { chooseShell, removeLaunchFiles, resolveCwd, scrubEnv, shellLaunch } from "./launch.ts";

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await removeTempDir(folder); });
const temp = () => { const folder = realpathSync(mkdtempSync(join(tmpdir(), "omb-terminal-launch-"))); folders.push(folder); return folder; };

describe("scrubEnv", () => {
  it("passes the allowlist and nothing the server holds secret", () => {
    const env = scrubEnv({
      PATH: "/usr/bin", HOME: "/home/me", USER: "me", SHELL: "/bin/zsh", LANG: "en_US.UTF-8", LC_ALL: "C", TMPDIR: "/tmp",
      OMB_COMMS_TOKEN: "t", OMB_HARNESS_URL: "http://127.0.0.1:1", ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k", OPENAI_BASE_URL: "u",
      GITHUB_TOKEN: "g", AWS_SECRET_ACCESS_KEY: "a", AWS_PROFILE: "p", SSH_AUTH_SOCK: "/tmp/agent", NPM_TOKEN: "n", MY_API_KEY: "m",
    }, "darwin");
    expect(Object.keys(env).sort()).toEqual(["COLORTERM", "HOME", "LANG", "LC_ALL", "PATH", "SHELL", "TERM", "TERM_PROGRAM", "TMPDIR", "USER"]);
    expect(env.TERM).toBe("xterm-256color");
  });

  it("keeps what Windows needs to start a shell, case-insensitively", () => {
    const env = scrubEnv({ Path: "C:\\Windows", SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\cmd.exe", OMB_COMMS_TOKEN: "t", GITHUB_TOKEN: "g" }, "win32");
    expect(env.Path).toBe("C:\\Windows");
    expect(env.SystemRoot).toBeDefined();
    expect(env.OMB_COMMS_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });
});

describe("resolveCwd", () => {
  it("starts in the default folder", () => {
    const root = temp();
    expect(resolveCwd(undefined, [root], root)).toEqual({ ok: true, cwd: root });
  });

  it("accepts a folder inside a root, relative or absolute", () => {
    const root = temp();
    mkdirSync(join(root, "app", "src"), { recursive: true });
    expect(resolveCwd("app", [root], root)).toEqual({ ok: true, cwd: join(root, "app") });
    expect(resolveCwd(join(root, "app", "src"), [root], root)).toEqual({ ok: true, cwd: join(root, "app", "src") });
  });

  it("refuses .. and folders outside every root", () => {
    const root = temp();
    const outside = temp();
    mkdirSync(join(root, "app"));
    expect(resolveCwd("app/../..", [root], root)).toEqual({ ok: false, error: TERMINAL_MESSAGES.cwdOutside });
    expect(resolveCwd(outside, [root], root)).toEqual({ ok: false, error: TERMINAL_MESSAGES.cwdOutside });
    expect(resolveCwd("/", [root], root)).toEqual({ ok: false, error: TERMINAL_MESSAGES.cwdOutside });
  });

  it.skipIf(!posix)("refuses a symlink that leads out of the root", () => {
    const root = temp();
    const outside = temp();
    symlinkSync(outside, join(root, "escape"));
    expect(resolveCwd("escape", [root], root)).toEqual({ ok: false, error: TERMINAL_MESSAGES.cwdOutside });
  });

  it("says a folder that is not there is missing, and a file is not a folder", () => {
    const root = temp();
    writeFileSync(join(root, "file"), "x");
    expect(resolveCwd("nothing", [root], root)).toEqual({ ok: false, error: TERMINAL_MESSAGES.cwdMissing });
    expect(resolveCwd("file", [root], root)).toEqual({ ok: false, error: TERMINAL_MESSAGES.cwdMissing });
  });
});

describe("chooseShell", () => {
  it.skipIf(!posix)("takes the person's own shell when none is asked for", () => {
    expect(chooseShell(undefined, { SHELL: "/bin/sh" }, "linux")).toEqual({ file: "/bin/sh", name: "sh" });
  });

  it("refuses a shell that is not on the list, even if it is a program", () => {
    expect(chooseShell("/bin/echo", {}, "linux")).toBeNull();
    expect(chooseShell("python3", {}, "linux")).toBeNull();
    expect(chooseShell("rm", {}, "linux")).toBeNull();
  });

  it.skipIf(!posix)("finds a listed shell in a system folder", () => {
    expect(chooseShell("sh", {}, "linux")?.name).toBe("sh");
  });

  it("offers only the Windows shells on Windows", () => {
    expect(chooseShell("pwsh", {}, "win32")).toEqual({ file: "pwsh.exe", name: "pwsh" });
    expect(chooseShell("bash", {}, "win32")).toBeNull();
  });
});

describe("shellLaunch", () => {
  it("sources the prompt marks through a temporary rc and never writes the person's own", () => {
    const home = temp();
    const zsh = shellLaunch({ file: "/bin/zsh", name: "zsh" }, { HOME: home }, true, "darwin");
    expect(zsh.integrated).toBe(true);
    expect(zsh.env.ZDOTDIR).toBe(zsh.cleanup);
    expect(zsh.env.OMB_USER_ZDOTDIR).toBe(home);
    expect(zsh.cleanup).not.toBeNull();
    const bash = shellLaunch({ file: "/bin/bash", name: "bash" }, { HOME: home }, true, "darwin");
    expect(bash.args[0]).toBe("--init-file");
    removeLaunchFiles(zsh.cleanup);
    removeLaunchFiles(bash.cleanup);
  });

  it("starts a plain login shell when the marks are off", () => {
    const launch = shellLaunch({ file: "/bin/zsh", name: "zsh" }, { HOME: "/h" }, false, "darwin");
    expect(launch).toEqual({ args: ["-l"], env: { HOME: "/h" }, integrated: false, cleanup: null });
  });
});
