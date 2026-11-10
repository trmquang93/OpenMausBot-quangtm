// Real shells on a real pty. Skipped where node-pty cannot start one; the fake-pty tests cover the logic there.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { spawnPty } from "./pty.ts";
import { TerminalManager, type Caller, type SessionInfo } from "./session-manager.ts";

const ME: Caller = { botId: "bot-a", threadId: "thread-1" };

function ptyWorks(): boolean {
  try {
    const probe = spawnPty({ file: "/bin/sh", args: ["-c", "exit 0"], cwd: process.cwd(), env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, cols: 80, rows: 24 });
    probe.kill();
    return true;
  } catch {
    return false;
  }
}

const unix = process.platform !== "win32";
const available = unix && ptyWorks();
const haveShell = (name: string) => existsSync(`/bin/${name}`) || existsSync(`/usr/bin/${name}`);
const vim = ["/usr/bin/vim", "/bin/vim", "/usr/local/bin/vim"].find((path) => existsSync(path));

const managers: TerminalManager[] = [];
afterEach(() => { for (const manager of managers.splice(0)) manager.shutdown(); });

function start(shell: "sh" | "bash" | "zsh" = "sh", integration = false) {
  const manager = new TerminalManager({
    spawn: spawnPty,
    env: { SHELL: `/bin/${shell}`, PATH: process.env.PATH, HOME: process.env.HOME },
    shellIntegration: () => integration,
  });
  managers.push(manager);
  const info = manager.open({ ...ME, title: "e2e", cwd: process.cwd(), shell, cols: 80, rows: 24 });
  return { manager, info };
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; !check(); await new Promise((resolve) => setTimeout(resolve, 25))) {
    if (Date.now() > deadline) throw new Error("timed out");
  }
}

function readAll(manager: TerminalManager, id: string, from = 0): string {
  return manager.read(ME, id, { cursor: from, maxBytes: 32_768 }).text;
}

function childPids(): number[] {
  const table = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  return table.split("\n").flatMap((line) => {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    return ppid === process.pid && pid ? [pid] : [];
  });
}

describe.skipIf(!available)("a real shell on a real pty", () => {
  it("runs commands, returns each one's output exactly once, and reports the exit code", async () => {
    const { manager, info } = start();
    await manager.wait(ME, info.id, { idleMs: 300, timeoutMs: 5_000 });
    const before = manager.read(ME, info.id).cursor;

    manager.write(ME, info.id, "printf 'a%sb\\n' X", true);
    await until(() => readAll(manager, info.id, before).includes("aXb\n"));
    const first = manager.read(ME, info.id, { cursor: before });
    expect(first.text).toContain("aXb");

    manager.write(ME, info.id, "sleep 0.2; printf second", true);
    await until(() => readAll(manager, info.id, first.cursor).includes("second"));
    const second = manager.read(ME, info.id, { cursor: first.cursor });
    expect(second.text).toContain("second");
    expect(second.text).not.toContain("aXb");
    expect(second.cursor).toBeGreaterThan(first.cursor);

    manager.write(ME, info.id, "exit 3", true);
    const waited = await manager.wait(ME, info.id, { idleMs: 10_000, timeoutMs: 10_000 });
    expect(waited).toMatchObject({ state: "exit", exitCode: 3 });
    expect(manager.read(ME, info.id)).toMatchObject({ state: "exited", exitCode: 3 });
  });

  it("follows a resize: the shell sees the new size", async () => {
    const { manager, info } = start();
    await manager.wait(ME, info.id, { idleMs: 300, timeoutMs: 5_000 });
    manager.write(ME, info.id, "stty size", true);
    await until(() => /\b24 80\b/.test(readAll(manager, info.id)));
    manager.resize(ME.threadId, info.id, 100, 30);
    manager.write(ME, info.id, "stty size", true);
    await until(() => /\b30 100\b/.test(readAll(manager, info.id)));
    expect(manager.list(ME)[0]).toMatchObject({ cols: 100, rows: 30 });
  });

  it.skipIf(!vim)("runs a full-screen program, resizes it and gets the shell back without a crash", async () => {
    const { manager, info } = start();
    await manager.wait(ME, info.id, { idleMs: 300, timeoutMs: 5_000 });
    const view = manager.attach(ME.threadId, info.id, { output() {}, exit() {} })!;
    manager.write(ME, info.id, `${vim} -u NONE -N -n -c 'sleep 1500m' -c 'qa!'; echo "VIM_$?_DONE"`, true);
    const screen = () => manager.attach(ME.threadId, info.id, { output() {}, exit() {} })!.snapshot.data;
    await until(() => screen().includes("\u001b[?1049h"));
    manager.resize(ME.threadId, info.id, 132, 43);
    await until(() => /VIM_0_DONE/.test(readAll(manager, info.id)), 15_000);
    expect(screen()).toContain("\u001b[?1049h");
    expect(manager.list(ME)[0]).toMatchObject({ state: "running", cols: 132, rows: 43 });
    view.detach();
  });

  it("leaves no child process of the server behind once its terminals are closed", async () => {
    const before = new Set(childPids());
    const { manager, info } = start();
    await manager.wait(ME, info.id, { idleMs: 300, timeoutMs: 5_000 });
    const mine = childPids().filter((pid) => !before.has(pid));
    expect(mine.length).toBeGreaterThan(0);
    const closed: SessionInfo = await manager.close(ME, info.id);
    expect(closed.state).toBe("exited");
    await until(() => childPids().every((pid) => !mine.includes(pid)), 5_000);
    expect(childPids().filter((pid) => mine.includes(pid))).toEqual([]);
  });

  it("leaves no child process behind after a shutdown either", async () => {
    const before = new Set(childPids());
    const { manager, info } = start();
    await manager.wait(ME, info.id, { idleMs: 300, timeoutMs: 5_000 });
    const mine = childPids().filter((pid) => !before.has(pid));
    manager.shutdown();
    await until(() => childPids().every((pid) => !mine.includes(pid)), 5_000);
  });

  for (const shell of ["bash", "zsh"] as const) {
    it.skipIf(!haveShell(shell))(`${shell} with prompt marks reports each finished command and its exit status`, async () => {
      const { manager, info } = start(shell, true);
      await manager.wait(ME, info.id, { idleMs: 1_000, timeoutMs: 15_000 });
      manager.write(ME, info.id, "(exit 4)", true);
      expect(await manager.wait(ME, info.id, { idleMs: 10_000, timeoutMs: 15_000 })).toMatchObject({ state: "done", exitCode: 4 });
      manager.write(ME, info.id, "true", true);
      expect(await manager.wait(ME, info.id, { idleMs: 10_000, timeoutMs: 15_000 })).toMatchObject({ state: "done", exitCode: 0 });
      expect(manager.read(ME, info.id).text).not.toContain("133;");
    });
  }
});
