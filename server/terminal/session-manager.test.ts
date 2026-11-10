import { afterEach, describe, expect, it, vi } from "vitest";

import { TERMINAL_KEY_BYTES, TERMINAL_LIMITS, TERMINAL_MESSAGES } from "../../shared/terminal.ts";
import { fakeSpawner, type FakePty } from "./fake-pty.ts";
import { TerminalError, TerminalManager, type Caller, type ManagerOptions, type OpenRequest } from "./session-manager.ts";

const ME: Caller = { botId: "bot-a", threadId: "thread-1" };
const OTHER_BOT: Caller = { botId: "bot-b", threadId: "thread-1" };
const OTHER_THREAD: Caller = { botId: "bot-a", threadId: "thread-2" };
const ENV = { SHELL: "/bin/sh", PATH: "/usr/bin:/bin", HOME: "/home/me", OMB_COMMS_TOKEN: "secret", ANTHROPIC_API_KEY: "secret" };

const managers: TerminalManager[] = [];
afterEach(() => { vi.useRealTimers(); for (const manager of managers.splice(0)) manager.shutdown(); });

function setup(options: Partial<ManagerOptions> = {}) {
  const { spawn, ptys } = fakeSpawner();
  const manager = new TerminalManager({ spawn, env: ENV, shellIntegration: () => false, ...options });
  managers.push(manager);
  const open = (who: Caller = ME, extra: Partial<OpenRequest> = {}) => manager.open({ ...who, title: "t", cwd: "/tmp", ...extra });
  return { manager, ptys, open };
}

const failure = (run: () => unknown): TerminalError => {
  try { run(); } catch (error) { if (error instanceof TerminalError) return error; throw error; }
  throw new Error("expected a TerminalError");
};
const failureOf = async (run: () => Promise<unknown>): Promise<TerminalError> => {
  try { await run(); } catch (error) { if (error instanceof TerminalError) return error; throw error; }
  throw new Error("expected a TerminalError");
};

describe("opening", () => {
  it("starts a shell in the folder with a scrubbed environment and a clamped size", () => {
    const { open, ptys } = setup();
    const info = open(ME, { cols: 5, rows: 9_999 });
    expect(info).toMatchObject({ botId: "bot-a", threadId: "thread-1", state: "running", cols: TERMINAL_LIMITS.minCols, rows: TERMINAL_LIMITS.maxRows, cursor: 0 });
    const spawned = ptys[0]!.options;
    expect(spawned.cwd).toBe("/tmp");
    expect(spawned.file).toBe("/bin/sh");
    expect(Object.keys(spawned.env)).not.toContain("OMB_COMMS_TOKEN");
    expect(Object.keys(spawned.env)).not.toContain("ANTHROPIC_API_KEY");
    expect(spawned.env.TERM).toBe("xterm-256color");
  });

  it("refuses to start when no shell can be found, without leaving a session", () => {
    const { manager, open } = setup({ env: { SHELL: "/nonexistent/shell", PATH: "" } });
    expect(failure(() => open(ME, { shell: "powershell" })).code).toBe("unavailable");
    expect(manager.list(ME)).toEqual([]);
  });

  it("reports a spawn that throws as unavailable and keeps nothing", () => {
    const manager = new TerminalManager({ spawn: () => { throw new Error("posix_spawnp failed"); }, env: ENV, shellIntegration: () => false });
    managers.push(manager);
    expect(failure(() => manager.open({ ...ME, title: "t", cwd: "/tmp" })).message).toBe(TERMINAL_MESSAGES.unavailable);
    expect(manager.list(ME)).toEqual([]);
  });
});

describe("limits", () => {
  it("holds a conversation to its own limit and lets another conversation open", () => {
    const { open } = setup({ limits: () => ({ perThread: 3, total: 12 }) });
    open(); open(); open();
    expect(failure(() => open()).code).toBe("limit_thread");
    expect(() => open(OTHER_THREAD)).not.toThrow();
  });

  it("holds the whole app to its limit", () => {
    const { open } = setup({ limits: () => ({ perThread: 5, total: 2 }) });
    open(ME); open(OTHER_THREAD);
    expect(failure(() => open({ botId: "bot-c", threadId: "thread-3" })).message).toBe(TERMINAL_MESSAGES.appLimit);
  });

  it("does not count a session that has ended", () => {
    const { open, ptys } = setup({ limits: () => ({ perThread: 1, total: 12 }) });
    open();
    expect(failure(() => open()).code).toBe("limit_thread");
    ptys[0]!.end(0);
    expect(() => open()).not.toThrow();
  });

  it("reads the limits again on every open, so a changed setting applies at once", () => {
    let perThread = 1;
    const { open } = setup({ limits: () => ({ perThread, total: 12 }) });
    open();
    expect(failure(() => open()).code).toBe("limit_thread");
    perThread = 2;
    expect(() => open()).not.toThrow();
  });

  it("limits how fast a conversation can open terminals", () => {
    let clock = 1_000_000;
    const { open, ptys } = setup({ now: () => clock, limits: () => ({ perThread: 100, total: 100 }) });
    for (let i = 0; i < TERMINAL_LIMITS.opensPerMinute; i += 1) open();
    expect(failure(() => open()).code).toBe("rate_limit");
    expect(ptys).toHaveLength(TERMINAL_LIMITS.opensPerMinute);
    clock += 61_000;
    expect(() => open()).not.toThrow();
  });
});

describe("ownership", () => {
  it("answers a session that is somebody else's exactly as it answers one that does not exist", async () => {
    const { manager, open } = setup();
    const { id } = open();
    const missing = "00000000-0000-4000-8000-000000000000";
    const calls: Array<(who: Caller, session: string) => unknown> = [
      (who, session) => manager.read(who, session),
      (who, session) => manager.write(who, session, "ls"),
      (who, session) => manager.key(who, session, "enter"),
      (who, session) => manager.wait(who, session, { idleMs: 50, timeoutMs: 100 }),
      (who, session) => manager.close(who, session),
    ];
    for (const call of calls) {
      const wrongBot = await failureOf(async () => call(OTHER_BOT, id));
      const wrongThread = await failureOf(async () => call(OTHER_THREAD, id));
      const gone = await failureOf(async () => call(ME, missing));
      expect(wrongBot.code).toBe("not_owner");
      expect(wrongBot.message).toBe(TERMINAL_MESSAGES.notOwner);
      expect({ code: wrongThread.code, message: wrongThread.message }).toEqual({ code: wrongBot.code, message: wrongBot.message });
      expect({ code: gone.code, message: gone.message }).toEqual({ code: wrongBot.code, message: wrongBot.message });
    }
  });

  it("changes nothing in a session its caller does not own", async () => {
    const { manager, open, ptys } = setup();
    const { id } = open();
    await failureOf(async () => manager.write(OTHER_BOT, id, "rm -rf /"));
    await failureOf(async () => manager.close(OTHER_THREAD, id, "kill"));
    expect(ptys[0]!.written).toEqual([]);
    expect(ptys[0]!.signals).toEqual([]);
    expect(manager.list(ME)[0]!.state).toBe("running");
  });

  it("lists only the caller's own sessions", () => {
    const { manager, open } = setup();
    const mine = open(ME);
    open(OTHER_BOT);
    open(OTHER_THREAD);
    expect(manager.list(ME).map((info) => info.id)).toEqual([mine.id]);
  });

  it("gives a person's view only the sessions of the conversation they are looking at", () => {
    const { manager, open } = setup();
    const { id } = open();
    expect(manager.attach("thread-2", id, { output() {}, exit() {} })).toBeUndefined();
    expect(manager.info("thread-2", id)).toBeUndefined();
    manager.type("thread-2", id, "x");
    manager.resize("thread-2", id, 100, 30);
    manager.stopFromPerson("thread-2", id);
    expect(manager.attach("thread-1", id, { output() {}, exit() {} })).toBeDefined();
  });
});

describe("typing", () => {
  it("writes text, adds Enter only on submit, and returns the cursor to read from", () => {
    const { manager, open, ptys } = setup();
    const { id } = open();
    ptys[0]!.print("$ ");
    expect(manager.write(ME, id, "ls")).toBe(2);
    expect(manager.write(ME, id, "pwd", true)).toBe(2);
    expect(ptys[0]!.written).toEqual(["ls", "pwd\r"]);
  });

  it("refuses text past its limit and unknown keys", () => {
    const { manager, open } = setup();
    const { id } = open();
    expect(failure(() => manager.write(ME, id, "x".repeat(TERMINAL_LIMITS.writeMaxBytes + 1))).message).toBe(TERMINAL_MESSAGES.writeTooLong);
    expect(failure(() => manager.key(ME, id, "ctrl-z")).message).toBe(TERMINAL_MESSAGES.keyUnknown);
    expect(failure(() => manager.key(ME, id, "constructor")).code).toBe("bad_request");
  });

  it("sends the bytes of each named key", () => {
    const { manager, open, ptys } = setup();
    const { id } = open();
    for (const key of Object.keys(TERMINAL_KEY_BYTES)) manager.key(ME, id, key);
    expect(ptys[0]!.written).toEqual(Object.values(TERMINAL_KEY_BYTES));
  });

  it("takes the person's keystrokes into the same shell", () => {
    const { manager, open, ptys } = setup();
    const { id } = open();
    manager.type("thread-1", id, "echo hi\r");
    manager.resize("thread-1", id, 90, 40);
    expect(ptys[0]!.written).toEqual(["echo hi\r"]);
    expect(ptys[0]!.resized).toEqual([[90, 40]]);
  });

  it("refuses to type into a session that has ended", () => {
    const { manager, open, ptys } = setup();
    const { id } = open();
    ptys[0]!.end(0);
    expect(failure(() => manager.write(ME, id, "ls")).message).toBe(TERMINAL_MESSAGES.exited);
  });
});

describe("reading", () => {
  it("returns only what is new since the cursor, with no byte lost or repeated", () => {
    const { manager, open, ptys } = setup();
    const { id } = open();
    ptys[0]!.print("one\r\n");
    const first = manager.read(ME, id);
    expect(first).toMatchObject({ text: "one\n", cursor: 5, omitted: 0, state: "running" });
    ptys[0]!.print("two\r\nthree\r\n");
    const second = manager.read(ME, id, { cursor: first.cursor });
    expect(second.text).toBe("two\nthree\n");
    expect(manager.read(ME, id, { cursor: second.cursor }).text).toBe("");
    expect(manager.read(ME, id, { cursor: 0 }).text).toBe("one\ntwo\nthree\n");
  });

  it("returns the newest part with a count of what was left out", () => {
    const { manager, open, ptys } = setup();
    const { id } = open();
    ptys[0]!.print(`${"a".repeat(100)}\r\nEND`);
    const read = manager.read(ME, id, { maxBytes: 10 });
    expect(read.text.endsWith("END")).toBe(true);
    expect(Buffer.byteLength(read.text)).toBeLessThanOrEqual(10);
    expect(read.omitted).toBeGreaterThan(90);
    expect(read.cursor).toBe(Buffer.byteLength(`${"a".repeat(100)}\r\nEND`));
  });

  it("caps a read at the most it may ever return", () => {
    const { manager, open, ptys } = setup();
    const { id } = open();
    ptys[0]!.print("x".repeat(TERMINAL_LIMITS.readMaxBytes * 2));
    expect(Buffer.byteLength(manager.read(ME, id, { maxBytes: 10_000_000 }).text)).toBeLessThanOrEqual(TERMINAL_LIMITS.readMaxBytes);
  });

  it("never returns an escape sequence, and waits for one that has only begun", () => {
    const { manager, open, ptys } = setup();
    const { id } = open();
    ptys[0]!.print("\u001b[31mred\u001b[0m ok \u001b[3");
    const first = manager.read(ME, id);
    expect(first.text).toBe("red ok");
    expect(first.text).not.toContain("\u001b");
    ptys[0]!.print("2mgreen\u001b[0m");
    expect(manager.read(ME, id, { cursor: first.cursor }).text).toBe("green");
  });

  it("starts after what the buffer has dropped and says how much that was", () => {
    const { manager, open, ptys } = setup();
    const { id } = open();
    const chunk = "x".repeat(60_000);
    for (let i = 0; i < 40; i += 1) ptys[0]!.print(chunk);
    const read = manager.read(ME, id, { cursor: 0 });
    expect(read.omitted).toBeGreaterThan(0);
  });

  it("reports the exit code once the program has ended, and still reads what it printed", () => {
    const { manager, open, ptys } = setup();
    const { id } = open();
    ptys[0]!.print("bye\r\n\u001b[");
    ptys[0]!.end(3);
    expect(manager.read(ME, id)).toMatchObject({ text: "bye\n", state: "exited", exitCode: 3 });
  });

  it("reports a program killed by a signal the way a shell does", () => {
    const { manager, open, ptys } = setup();
    const { id } = open();
    ptys[0]!.end(0, 9);
    expect(manager.read(ME, id).exitCode).toBe(137);
  });
});

describe("waiting", () => {
  const opts = { idleMs: 60, timeoutMs: 3_000 };

  it("returns idle once nothing has printed for idle_ms", async () => {
    const { manager, open, ptys } = setup();
    const { id } = open();
    ptys[0]!.print("$ ");
    const started = Date.now();
    const waited = await manager.wait(ME, id, opts);
    expect(waited).toMatchObject({ state: "idle", cursor: 2 });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("does not call a terminal idle while it keeps printing", async () => {
    const { manager, open, ptys } = setup();
    const { id } = open();
    const ticker = setInterval(() => ptys[0]!.print("."), 20);
    const waiting = manager.wait(ME, id, { idleMs: 100, timeoutMs: 250 });
    expect((await waiting).state).toBe("timeout");
    clearInterval(ticker);
  });

  it("counts typing as activity, so a command just sent is not called idle", async () => {
    let clock = 10_000;
    const { manager, open } = setup({ now: () => clock });
    const { id } = open();
    clock += 5_000;
    manager.write(ME, id, "make", true);
    const waited = await Promise.race([manager.wait(ME, id, { idleMs: 800, timeoutMs: 100 }), new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 30))]);
    expect(waited).toBe("pending");
  });

  it("returns done with the exit status when the shell marks the command finished", async () => {
    const { manager, open, ptys } = setup();
    const { id } = open();
    manager.write(ME, id, "false", true);
    const waiting = manager.wait(ME, id, { idleMs: 10_000, timeoutMs: 3_000 });
    ptys[0]!.print("false\r\n\u001b]133;C\u0007");
    ptys[0]!.print("\u001b]133;D;1\u0007\u001b]133;A\u0007$ ");
    expect(await waiting).toMatchObject({ state: "done", exitCode: 1 });
  });

  it("finds a mark that was split across two reads of the stream", async () => {
    const { manager, open, ptys } = setup();
    const { id } = open();
    manager.write(ME, id, "true", true);
    const waiting = manager.wait(ME, id, { idleMs: 10_000, timeoutMs: 3_000 });
    ptys[0]!.print("\u001b]133;D");
    ptys[0]!.print(";0\u0007");
    expect(await waiting).toMatchObject({ state: "done", exitCode: 0 });
  });

  it("ignores a command that finished before the one just typed", async () => {
    const { manager, open, ptys } = setup();
    const { id } = open();
    ptys[0]!.print("\u001b]133;D;0\u0007");
    manager.write(ME, id, "sleep 5", true);
    expect((await manager.wait(ME, id, { idleMs: 10_000, timeoutMs: 150 })).state).toBe("timeout");
  });

  it("returns prompt when the last line matches the bot's pattern, only for output after the last write", async () => {
    const { manager, open, ptys } = setup();
    const { id } = open();
    ptys[0]!.print("Overwrite? [y/n] ");
    manager.write(ME, id, "cp a b", true);
    const early = await manager.wait(ME, id, { idleMs: 10_000, timeoutMs: 100, prompt: /\[y\/n\]/i });
    expect(early.state).toBe("timeout");
    const waiting = manager.wait(ME, id, { idleMs: 10_000, timeoutMs: 3_000, prompt: /\[y\/n\]/i });
    ptys[0]!.print("\r\n\u001b[1mContinue? [Y/N]\u001b[0m ");
    expect((await waiting).state).toBe("prompt");
  });

  it("returns exit with the code when the program ends", async () => {
    const { manager, open, ptys } = setup();
    const { id } = open();
    const waiting = manager.wait(ME, id, { idleMs: 10_000, timeoutMs: 3_000 });
    ptys[0]!.end(7);
    expect(await waiting).toMatchObject({ state: "exit", exitCode: 7 });
  });

  it("always returns: a timeout when nothing happens, and when the caller goes away", async () => {
    const { manager, open } = setup();
    const { id } = open();
    expect((await manager.wait(ME, id, { idleMs: 10_000, timeoutMs: 80 })).state).toBe("timeout");
    const abort = new AbortController();
    const waiting = manager.wait(ME, id, { idleMs: 10_000, timeoutMs: 60_000, signal: abort.signal });
    abort.abort();
    expect((await waiting).state).toBe("timeout");
    abort.abort();
    expect((await manager.wait(ME, id, { idleMs: 10_000, timeoutMs: 60_000, signal: abort.signal })).state).toBe("timeout");
  });
});

describe("closing", () => {
  it("hangs up, then terminates, then kills a shell that will not go", () => {
    vi.useFakeTimers();
    const { manager, open, ptys } = setup();
    const { id } = open();
    void manager.close(ME, id);
    expect(ptys[0]!.signals).toEqual(["SIGHUP"]);
    vi.advanceTimersByTime(3_000);
    expect(ptys[0]!.signals).toEqual(["SIGHUP", "SIGTERM"]);
    vi.advanceTimersByTime(5_000);
    expect(ptys[0]!.signals).toEqual(["SIGHUP", "SIGTERM", "SIGKILL"]);
  });

  it("kills at once on request, and stops escalating once the shell has gone", async () => {
    const { manager, open, ptys } = setup();
    const { id } = open();
    const closing = manager.close(ME, id, "kill");
    expect(ptys[0]!.signals).toEqual(["SIGKILL"]);
    ptys[0]!.end(0, 9);
    expect(await closing).toMatchObject({ state: "exited", exitCode: 137 });
    const again = await manager.close(ME, id);
    expect(again.state).toBe("exited");
    expect(ptys[0]!.signals).toEqual(["SIGKILL"]);
  });

  it("tells the card's owner when a session ends, with the last lines of what it printed", () => {
    const onExit = vi.fn();
    const { open, ptys } = setup({ onExit });
    const { id } = open();
    ptys[0]!.print("\u001b[32mall green\u001b[0m\r\n");
    ptys[0]!.end(0);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit.mock.calls[0]![0]).toMatchObject({ id, state: "exited", exitCode: 0 });
    expect(onExit.mock.calls[0]![1]).toBe("all green");
  });

  it("stops the shells of a conversation, of a bot, or of everything that is gone", () => {
    const live = new Set(["thread-1", "thread-3"]);
    const { manager, open, ptys } = setup({ threadLive: (_bot, thread) => live.has(thread) });
    open(ME); open(OTHER_THREAD); open({ botId: "bot-b", threadId: "thread-3" }); open({ botId: "bot-c", threadId: "thread-4" });
    manager.closeThread("thread-1");
    expect(ptys[0]!.signals).toEqual(["SIGHUP"]);
    expect(manager.list(ME)).toEqual([]);
    manager.reconcile("bot-a");
    expect(ptys[1]!.signals).toEqual(["SIGHUP"]);
    expect(ptys[2]!.signals).toEqual([]);
    manager.reconcile();
    expect(ptys[3]!.signals).toEqual(["SIGHUP"]);
    manager.closeBot("bot-b");
    expect(ptys[2]!.signals).toEqual(["SIGHUP"]);
  });

  it("kills every shell on shutdown and hands back the ones that were still running", () => {
    const { manager, open, ptys } = setup();
    open(ME); open(OTHER_THREAD);
    ptys[0]!.print("working\r\n");
    ptys[1]!.end(0);
    const ended = manager.shutdown();
    expect(ptys[0]!.signals).toEqual(["SIGKILL"]);
    expect(ptys[1]!.signals).toEqual([]);
    expect(ended).toHaveLength(1);
    expect(ended[0]!.lastOutput).toBe("working");
    expect(failure(() => manager.open({ ...ME, title: "t", cwd: "/tmp" })).code).toBe("unavailable");
  });

  it("closes a terminal nobody has watched or typed in for the idle limit, and keeps a watched one", async () => {
    let clock = 1_000;
    const { manager, open, ptys } = setup({ now: () => clock, idleCloseMs: 1_000, sweepMs: 10 });
    const quiet = open(ME);
    const watched = open(OTHER_THREAD);
    manager.attach("thread-2", watched.id, { output() {}, exit() {} });
    clock += 5_000;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(ptys[0]!.signals).toEqual(["SIGHUP"]);
    expect(ptys[1]!.signals).toEqual([]);
    expect(quiet.id).not.toBe(watched.id);
  });
});

describe("a person's view", () => {
  it("gets the newest output, then every later byte in order, and the end of the session", () => {
    const { manager, open, ptys } = setup();
    const { id } = open();
    ptys[0]!.print("before\r\n");
    const seen: Array<[number, string]> = [];
    const exits: number[] = [];
    const view = manager.attach("thread-1", id, { output: (seq, data) => seen.push([seq, data]), exit: (code) => exits.push(code) })!;
    expect(view.snapshot).toEqual({ seq: 0, data: "before\r\n", omitted: 0 });
    ptys[0]!.print("after\r\n");
    ptys[0]!.end(0);
    expect(seen).toEqual([[8, "after\r\n"]]);
    expect(exits).toEqual([0]);
    view.detach();
  });

  it("stops sending once the view has gone", () => {
    const { manager, open, ptys } = setup();
    const { id } = open();
    const seen: string[] = [];
    manager.attach("thread-1", id, { output: (_seq, data) => seen.push(data), exit() {} })!.detach();
    ptys[0]!.print("late");
    expect(seen).toEqual([]);
  });

  it("starts a snapshot of a long stream partway and says how much came before", () => {
    const { manager, open, ptys } = setup();
    const { id } = open();
    const chunk = "y".repeat(50_000);
    for (let i = 0; i < 10; i += 1) ptys[0]!.print(chunk);
    const { snapshot } = manager.attach("thread-1", id, { output() {}, exit() {} })!;
    expect(Buffer.byteLength(snapshot.data)).toBeLessThanOrEqual(TERMINAL_LIMITS.snapshotBytes);
    expect(snapshot.omitted).toBe(snapshot.seq);
    expect(snapshot.seq).toBeGreaterThan(0);
  });

  it("stops the shell when the person presses Stop", () => {
    const { manager, open, ptys } = setup();
    const { id } = open();
    manager.stopFromPerson("thread-1", id);
    expect(ptys[0]!.signals).toEqual(["SIGHUP"]);
  });
});

describe("a pty fixture", () => {
  it("is the only thing a test needs to drive a session", () => {
    const { ptys, open } = setup();
    open();
    const pty: FakePty = ptys[0]!;
    expect(pty.pid).toBe(4242);
  });
});
