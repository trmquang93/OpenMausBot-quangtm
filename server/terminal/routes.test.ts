import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import type { ApprovalMode } from "../../shared/approval-mode.ts";
import { TERMINAL_CLOSE, TERMINAL_MESSAGES, type TerminalPayload, type TerminalServerFrame } from "../../shared/terminal.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { dispatchRoutes, PASS } from "../routes/table.ts";
import { createUpgrades } from "../routes/upgrades.ts";
import type { StoreChange } from "../store.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { fakeSpawner } from "./fake-pty.ts";
import { createTerminalHost, type InternalTerminalContext, type TerminalRow } from "./routes.ts";

const AUTH = { kind: "loopback", scopes: ["admin", "client"] } as RequestAuth;
const DIRECT = { botId: "bot-a", threadId: "thread-1" };
const OTHER_THREAD = { botId: "bot-a", threadId: "thread-2" };
const OTHER_BOT = { botId: "bot-b", threadId: "thread-1" };

interface Row extends TerminalRow { threadId: string; terminal: TerminalPayload }

const closers: Array<() => Promise<void> | void> = [];
const folders: string[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const folder of folders.splice(0)) await removeTempDir(folder);
});

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omb-terminal-routes-")));
  folders.push(root);
  mkdirSync(join(root, "app"));
  const { spawn, ptys } = fakeSpawner();
  const state = {
    approval: "full" as ApprovalMode,
    rooms: new Set<string>(["room-1"]),
    visible: new Set<string>(["thread-1", "thread-2"]),
    live: true,
    settings: {} as { maxPerThread?: number; maxTotal?: number; shellIntegration?: boolean },
    rows: [] as Row[],
    patches: [] as Array<{ threadId: string; messageId: string; terminal: TerminalPayload }>,
    listeners: [] as Array<(change: StoreChange) => void>,
    threadsLive: true,
    owner: true,
  };
  const upgrades = createUpgrades();
  const host = createTerminalHost({
    upgrades,
    spawn,
    settings: () => state.settings,
    directBot: (threadId) => (state.rooms.has(threadId) ? null : threadId.startsWith("thread") ? "bot-a" : null),
    inRoom: (_botId, threadId) => state.rooms.has(threadId),
    approval: () => state.approval,
    folders: () => ({ roots: [root], cwd: root }),
    canSee: (_auth, threadId) => state.visible.has(threadId),
    canWrite: () => state.owner,
    live: () => state.live,
    threadLive: () => state.threadsLive,
    appendRow: (threadId, row) => { const added = { id: `msg-${state.rows.length + 1}`, threadId, terminal: row.terminal }; state.rows.push(added); return added; },
    patchRow: (threadId, messageId, patch) => {
      state.patches.push({ threadId, messageId, terminal: patch.terminal });
      const row = state.rows.find((candidate) => candidate.id === messageId);
      if (row) row.terminal = patch.terminal;
    },
    findRow: (threadId, sessionId) => state.rows.find((row) => row.threadId === threadId && row.terminal.sessionId === sessionId),
    onChange: (listener) => { state.listeners.push(listener); return () => { state.listeners = state.listeners.filter((one) => one !== listener); }; },
  });
  closers.push(() => host.shutdown());
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!await dispatchRoutes([host.route], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: AUTH, json, readBody })) json(res, 404, { error: "no route" });
  };
  const server: Server = createServer((req, res) => void handle(req, res));
  upgrades.attach(server, handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const port = (server.address() as AddressInfo).port;

  async function call(who: { botId: string; threadId: string }, op: string, body: unknown = {}) {
    let status = 0;
    let payload: Record<string, unknown> = {};
    const res = { writeHead: (code: number) => { status = code; }, end: (text: string) => { payload = JSON.parse(text) as Record<string, unknown>; }, setHeader: () => {}, headersSent: false, once: () => {} } as unknown as ServerResponse;
    const ctx: InternalTerminalContext = {
      method: "POST", path: `/api/internal/terminal/${op}`, res, botId: who.botId, threadId: who.threadId, readBody: async () => body,
      json: (response, code, data) => { status = code; payload = JSON.parse(JSON.stringify(data)) as Record<string, unknown>; void response; },
    };
    const out = await host.internal(ctx);
    return { out, status, payload };
  }

  function http(method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {} }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  function socket(threadId: string, sessionId: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/threads/${threadId}/terminal/${sessionId}`);
    const frames: TerminalServerFrame[] = [];
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    ws.on("message", (data) => frames.push(JSON.parse(String(data)) as TerminalServerFrame));
    const opened = new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
    closers.push(() => { ws.terminate(); });
    return { ws, frames, closed, opened };
  }

  return { host, state, ptys, call, http, socket, root, port };
}

const until = async (check: () => boolean, timeoutMs = 3_000) => {
  for (const deadline = Date.now() + timeoutMs; !check(); await new Promise((resolve) => setTimeout(resolve, 10))) {
    if (Date.now() > deadline) throw new Error("timed out");
  }
};

describe("a bot's calls", () => {
  it("opens a terminal at Full access and puts its card in the chat", async () => {
    const f = await fixture();
    const opened = await f.call(DIRECT, "open", { title: "Run tests", cols: 100, rows: 30 });
    expect(opened.status).toBe(200);
    expect(opened.payload).toMatchObject({ title: "Run tests", cwd: f.root, cols: 100, rows: 30, cursor: 0 });
    expect(f.state.rows).toHaveLength(1);
    expect(f.state.rows[0]!.terminal).toMatchObject({ sessionId: opened.payload.session_id, title: "Run tests", cwd: f.root, state: "running" });
    expect(opened.payload.message_id).toBe(f.state.rows[0]!.id);
  });

  it("answers a path that is not its own with PASS", async () => {
    const f = await fixture();
    const res = { writeHead() {}, end() {}, setHeader() {} } as unknown as ServerResponse;
    expect(await f.host.internal({ method: "POST", path: "/api/internal/waits", res, json, botId: "b", threadId: "t", readBody: async () => ({}) })).toBe(PASS);
    expect(await f.host.internal({ method: "GET", path: "/api/internal/terminal/list", res, json, botId: "b", threadId: "t", readBody: async () => ({}) })).toBe(PASS);
  });

  it("opens, types and presses keys only at Full access, and reads, waits, lists and closes at any level", async () => {
    const f = await fixture();
    const { payload } = await f.call(DIRECT, "open");
    const id = payload.session_id as string;
    for (const level of ["ask", "edits", "auto", "custom"] as const) {
      f.state.approval = level;
      for (const [op, body] of [["open", {}], ["write", { session_id: id, text: "ls" }], ["key", { session_id: id, key: "enter" }]] as const) {
        const refused = await f.call(DIRECT, op, body);
        expect(refused.status, `${level} ${op}`).toBe(403);
        expect(refused.payload.error).toBe(TERMINAL_MESSAGES.needsFullAccess);
      }
      expect((await f.call(DIRECT, "read", { session_id: id })).status, level).toBe(200);
      expect((await f.call(DIRECT, "list")).status, level).toBe(200);
      expect((await f.call(DIRECT, "wait", { session_id: id, timeout_ms: 100, idle_ms: 50 })).status, level).toBe(200);
    }
    expect(f.ptys).toHaveLength(1);
    expect(f.ptys[0]!.written).toEqual([]);
    f.state.approval = "ask";
    expect((await f.call(DIRECT, "close", { session_id: id })).status).toBe(200);
  });

  it("checks the level again on every call, so lowering it takes effect at once", async () => {
    const f = await fixture();
    const { payload } = await f.call(DIRECT, "open");
    const id = payload.session_id as string;
    expect((await f.call(DIRECT, "write", { session_id: id, text: "a" })).status).toBe(200);
    f.state.approval = "ask";
    expect((await f.call(DIRECT, "write", { session_id: id, text: "b" })).status).toBe(403);
    f.state.approval = "full";
    expect((await f.call(DIRECT, "write", { session_id: id, text: "c" })).status).toBe(200);
    expect(f.ptys[0]!.written).toEqual(["a", "c"]);
  });

  it("offers nothing in a room", async () => {
    const f = await fixture();
    for (const op of ["open", "write", "key", "read", "wait", "close", "list"]) {
      const refused = await f.call({ botId: "bot-a", threadId: "room-1" }, op, { session_id: "x", text: "x", key: "enter" });
      expect(refused.status, op).toBe(403);
      expect(refused.payload.error, op).toBe(TERMINAL_MESSAGES.room);
    }
    expect(f.ptys).toHaveLength(0);
  });

  it("answers a session of another bot or conversation exactly as it answers one that does not exist", async () => {
    const f = await fixture();
    const { payload } = await f.call(DIRECT, "open");
    const id = payload.session_id as string;
    const missing = "11111111-1111-4111-8111-111111111111";
    for (const op of ["write", "key", "read", "wait", "close"]) {
      const body = { session_id: id, text: "x", key: "enter", timeout_ms: 100 };
      const wrongBot = await f.call(OTHER_BOT, op, body);
      const wrongThread = await f.call(OTHER_THREAD, op, body);
      const gone = await f.call(DIRECT, op, { ...body, session_id: missing });
      expect(wrongBot.status, op).toBe(404);
      expect(wrongBot.payload.error, op).toBe(TERMINAL_MESSAGES.notOwner);
      expect(wrongThread, op).toEqual({ ...wrongBot, out: wrongThread.out });
      expect(gone, op).toEqual({ ...wrongBot, out: gone.out });
    }
    expect(f.ptys[0]!.written).toEqual([]);
    expect((await f.call(OTHER_BOT, "list")).payload).toEqual({ sessions: [] });
    expect((await f.call(DIRECT, "list")).payload.sessions).toHaveLength(1);
  });

  it("takes who is calling from the capability, never from what the model sent", async () => {
    const f = await fixture();
    const { payload } = await f.call(DIRECT, "open");
    const forged = await f.call(OTHER_BOT, "read", { session_id: payload.session_id, botId: "bot-a", threadId: "thread-1", bot_id: "bot-a", thread_id: "thread-1" });
    expect(forged.status).toBe(404);
    expect(forged.payload.error).toBe(TERMINAL_MESSAGES.notOwner);
  });

  it("starts only inside the allowed folders", async () => {
    const f = await fixture();
    const inside = await f.call(DIRECT, "open", { cwd: "app" });
    expect(inside.payload.cwd).toBe(join(f.root, "app"));
    for (const cwd of ["..", "app/../..", "/", tmpdir()]) {
      const refused = await f.call(DIRECT, "open", { cwd });
      expect(refused.status, cwd).toBe(400);
      expect(refused.payload.error, cwd).toBe(TERMINAL_MESSAGES.cwdOutside);
    }
    expect((await f.call(DIRECT, "open", { cwd: "nothing" })).payload.error).toBe(TERMINAL_MESSAGES.cwdMissing);
  });

  it("masks a secret in the card's title and holds the conversation to its limit", async () => {
    const f = await fixture();
    f.state.settings = { maxPerThread: 2 };
    const first = await f.call(DIRECT, "open", { title: "deploy --token abc123secretvalue9" });
    expect(String(first.payload.title)).not.toContain("abc123secretvalue9");
    await f.call(DIRECT, "open");
    const third = await f.call(DIRECT, "open");
    expect(third.status).toBe(429);
    expect(third.payload.error).toBe(TERMINAL_MESSAGES.threadLimit);
  });

  it("types, presses keys and reads without echoing the text back", async () => {
    const f = await fixture();
    const { payload } = await f.call(DIRECT, "open");
    const id = payload.session_id as string;
    f.ptys[0]!.print("$ ");
    const wrote = await f.call(DIRECT, "write", { session_id: id, text: "echo SECRET_VALUE", submit: true });
    expect(JSON.stringify(wrote.payload)).not.toContain("SECRET_VALUE");
    expect(wrote.payload).toEqual({ ok: true, cursor: 2 });
    expect((await f.call(DIRECT, "key", { session_id: id, key: "ctrl-c" })).payload).toEqual({ ok: true, cursor: 2 });
    expect(f.ptys[0]!.written).toEqual(["echo SECRET_VALUE\r", "\x03"]);
    expect((await f.call(DIRECT, "key", { session_id: id, key: "ctrl-z" })).status).toBe(400);
    f.ptys[0]!.print("out\r\n");
    expect((await f.call(DIRECT, "read", { session_id: id, cursor: 2 })).payload).toMatchObject({ output: "out\n", cursor: 7, omitted: 0, state: "running" });
  });

  it("waits, and says why it stopped", async () => {
    const f = await fixture();
    const { payload } = await f.call(DIRECT, "open");
    const id = payload.session_id as string;
    expect((await f.call(DIRECT, "wait", { session_id: id, idle_ms: 50, timeout_ms: 1_000 })).payload).toMatchObject({ state: "idle" });
    expect((await f.call(DIRECT, "wait", { session_id: id, prompt: "(" })).payload.error).toBe(TERMINAL_MESSAGES.patternInvalid);
    const waiting = f.call(DIRECT, "wait", { session_id: id, idle_ms: 10_000, timeout_ms: 5_000 });
    setTimeout(() => f.ptys[0]!.end(2), 20);
    expect((await waiting).payload).toMatchObject({ state: "exit", exit_code: 2 });
  });

  it("closes a terminal and leaves the card with its last lines and the exit code", async () => {
    const f = await fixture();
    const { payload } = await f.call(DIRECT, "open");
    const id = payload.session_id as string;
    f.ptys[0]!.print("\u001b[32mbuild ok\u001b[0m\r\n");
    const closing = f.call(DIRECT, "close", { session_id: id });
    await until(() => f.ptys[0]!.signals.length > 0);
    expect(f.ptys[0]!.signals).toEqual(["SIGHUP"]);
    f.ptys[0]!.end(0);
    expect((await closing).payload).toMatchObject({ ok: true, state: "exited", exit_code: 0 });
    expect(f.state.patches.at(-1)).toMatchObject({ threadId: "thread-1", messageId: payload.message_id, terminal: { state: "exited", exitCode: 0, lastLines: "build ok" } });
  });

  it("stops the terminals of a conversation that is deleted, archived or whose bot is deleted", async () => {
    const f = await fixture();
    await f.call(DIRECT, "open");
    await f.call(OTHER_THREAD, "open");
    f.state.listeners.forEach((listener) => listener({ type: "thread.deleted", threadId: "thread-1" }));
    expect(f.ptys[0]!.signals).toEqual(["SIGHUP"]);
    f.state.threadsLive = false;
    f.state.listeners.forEach((listener) => listener({ type: "bot", botId: "bot-a" }));
    expect(f.ptys[1]!.signals).toEqual(["SIGHUP"]);
    await f.call({ botId: "bot-b", threadId: "thread-9" }, "open");
    f.state.listeners.forEach((listener) => listener({ type: "bot.deleted", botId: "bot-b" }));
    expect(f.ptys[2]!.signals).toEqual(["SIGHUP"]);
  });

  it("leaves a terminal running when only the conversation's active branch moves, and stops it once archived", async () => {
    const f = await fixture();
    await f.call(DIRECT, "open");
    f.state.listeners.forEach((listener) => listener({ type: "thread", threadId: "thread-1", activeLeafId: "m9" }));
    expect(f.ptys[0]!.signals).toEqual([]);
    f.state.threadsLive = false;
    f.state.listeners.forEach((listener) => listener({ type: "bot", botId: "bot-a" }));
    expect(f.ptys[0]!.signals).toEqual(["SIGHUP"]);
  });

  it("keeps a secret the program printed out of the stored card and out of the patch", async () => {
    const f = await fixture();
    const { payload } = await f.call(DIRECT, "open");
    const ghp = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const anthropic = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345";
    f.ptys[0]!.print(`token ${ghp} and ${anthropic}\r\n`);
    f.ptys[0]!.end(0);
    const stored = f.state.rows.find((row) => row.id === payload.message_id)!.terminal;
    expect(stored.lastLines).toBe("token «redacted 40 chars» and «redacted 45 chars»");
    for (const text of [JSON.stringify(stored), JSON.stringify(f.state.patches)]) {
      expect(text).not.toContain(ghp);
      expect(text).not.toContain(anthropic);
    }
  });

  it("marks the card of every running terminal as ended when the server shuts down", async () => {
    const f = await fixture();
    const { payload } = await f.call(DIRECT, "open");
    f.ptys[0]!.print("still going\r\n");
    f.host.shutdown();
    expect(f.ptys[0]!.signals).toEqual(["SIGKILL"]);
    expect(f.state.patches.at(-1)).toMatchObject({ messageId: payload.message_id, terminal: { state: "exited", lastLines: "still going" } });
  });
});

describe("a person's terminal card", () => {
  it("streams the session to the conversation it belongs to, takes keystrokes and a resize, and ends with it", async () => {
    const f = await fixture();
    const id = (await f.call(DIRECT, "open", { cols: 90, rows: 25 })).payload.session_id as string;
    f.ptys[0]!.print("hello\r\n");
    const view = f.socket("thread-1", id);
    await view.opened;
    await until(() => view.frames.length >= 2);
    expect(view.frames[0]).toEqual({ t: "s", state: "running", cols: 90, rows: 25 });
    expect(view.frames[1]).toEqual({ t: "o", seq: 0, data: "hello\r\n" });

    f.ptys[0]!.print("more");
    await until(() => view.frames.length >= 3);
    expect(view.frames[2]).toEqual({ t: "o", seq: 7, data: "more" });

    view.ws.send(JSON.stringify({ t: "i", data: "ls\r" }));
    view.ws.send(JSON.stringify({ t: "r", cols: 120, rows: 40 }));
    await until(() => f.ptys[0]!.resized.length === 1);
    expect(f.ptys[0]!.written).toEqual(["ls\r"]);
    expect(f.ptys[0]!.resized).toEqual([[120, 40]]);

    f.ptys[0]!.end(0);
    expect(await view.closed).toBe(TERMINAL_CLOSE.ended);
    expect(view.frames.at(-1)).toEqual({ t: "x", code: 0 });
  });

  it("stops the shell when the person presses Stop, and ignores frames it does not know", async () => {
    const f = await fixture();
    const id = (await f.call(DIRECT, "open")).payload.session_id as string;
    const view = f.socket("thread-1", id);
    await view.opened;
    view.ws.send("not json");
    view.ws.send(JSON.stringify({ t: "zz" }));
    view.ws.send(JSON.stringify({ t: "i", data: 5 }));
    view.ws.send(JSON.stringify({ t: "c" }));
    await until(() => f.ptys[0]!.signals.length > 0);
    expect(f.ptys[0]!.signals).toEqual(["SIGHUP"]);
    expect(f.ptys[0]!.written).toEqual([]);
  });

  it("lets a person who only sees the conversation read, and closes the socket on the first frame that would write", async () => {
    const f = await fixture();
    const id = (await f.call(DIRECT, "open")).payload.session_id as string;
    f.state.owner = false;
    f.ptys[0]!.print("shared\r\n");
    for (const frame of [{ t: "i", data: "rm -rf ~\r" }, { t: "r", cols: 20, rows: 5 }, { t: "c" }]) {
      const view = f.socket("thread-1", id);
      await view.opened;
      await until(() => view.frames.length >= 2);
      expect(view.frames[0]).toEqual({ t: "s", state: "running", cols: 120, rows: 30, readOnly: true });
      expect(view.frames[1]).toEqual({ t: "o", seq: 0, data: "shared\r\n" });
      view.ws.send(JSON.stringify(frame));
      expect(await view.closed, frame.t).toBe(TERMINAL_CLOSE.readOnly);
    }
    expect(f.ptys[0]!.written).toEqual([]);
    expect(f.ptys[0]!.resized).toEqual([]);
    expect(f.ptys[0]!.signals).toEqual([]);

    f.state.owner = true;
    const owner = f.socket("thread-1", id);
    await owner.opened;
    await until(() => owner.frames.length >= 1);
    expect(owner.frames[0]).toEqual({ t: "s", state: "running", cols: 120, rows: 30 });
    owner.ws.send(JSON.stringify({ t: "i", data: "ls\r" }));
    await until(() => f.ptys[0]!.written.length === 1);
    expect(f.ptys[0]!.written).toEqual(["ls\r"]);
  });

  it("answers a malformed percent-encoding in the path with 404, not 500", async () => {
    const f = await fixture();
    expect((await f.http("GET", "/api/threads/%E0%A4%A/terminal/abc")).status).toBe(404);
    expect((await f.http("POST", "/api/threads/%E0%A4%A/terminal/abc/restart")).status).toBe(404);
  });

  it("closes at once for a session that is not in that conversation, whatever the person can see", async () => {
    const f = await fixture();
    const id = (await f.call(DIRECT, "open")).payload.session_id as string;
    const wrongThread = f.socket("thread-2", id);
    await wrongThread.opened;
    expect(await wrongThread.closed).toBe(TERMINAL_CLOSE.unavailable);
    const missing = f.socket("thread-1", "00000000-0000-4000-8000-000000000000");
    await missing.opened;
    expect(await missing.closed).toBe(TERMINAL_CLOSE.unavailable);
    expect(wrongThread.frames).toEqual([]);
    expect(f.ptys[0]!.written).toEqual([]);
  });

  it("refuses the handshake for a conversation the person cannot see", async () => {
    const f = await fixture();
    const id = (await f.call(DIRECT, "open")).payload.session_id as string;
    f.state.visible.delete("thread-1");
    const view = f.socket("thread-1", id);
    await expect(view.opened).rejects.toThrow(/404/);
  });

  it("refuses a request from another site, and a plain GET with no upgrade", async () => {
    const f = await fixture();
    const id = (await f.call(DIRECT, "open")).payload.session_id as string;
    const path = `/api/threads/thread-1/terminal/${id}`;
    expect((await f.http("GET", path, { origin: "http://evil.example" })).status).toBe(403);
    expect((await f.http("GET", path)).status).toBe(426);
    expect((await f.http("PUT", path)).status).toBe(405);
  });

  it("shows an ended session its last output and then closes", async () => {
    const f = await fixture();
    const id = (await f.call(DIRECT, "open")).payload.session_id as string;
    f.ptys[0]!.print("done\r\n");
    f.ptys[0]!.end(5);
    const view = f.socket("thread-1", id);
    await view.opened;
    expect(await view.closed).toBe(TERMINAL_CLOSE.ended);
    expect(view.frames).toEqual([
      { t: "s", state: "exited", cols: 120, rows: 30, exitCode: 5 },
      { t: "o", seq: 0, data: "done\r\n" },
      { t: "x", code: 5 },
    ]);
  });

  it("starts a fresh shell in the same card when the person asks to start again", async () => {
    const f = await fixture();
    const opened = (await f.call(DIRECT, "open", { title: "Dev server", cwd: "app", cols: 100, rows: 30 })).payload;
    const oldId = opened.session_id as string;
    expect((await f.http("POST", `/api/threads/thread-1/terminal/${oldId}/restart`)).status).toBe(409);
    f.ptys[0]!.end(0);
    const restarted = await f.http("POST", `/api/threads/thread-1/terminal/${oldId}/restart`);
    expect(restarted.status).toBe(200);
    const terminal = restarted.body.terminal as TerminalPayload;
    expect(terminal).toMatchObject({ title: "Dev server", cwd: join(f.root, "app"), cols: 100, rows: 30, state: "running" });
    expect(terminal.sessionId).not.toBe(oldId);
    expect(f.state.rows).toHaveLength(1);
    expect(f.state.rows[0]!.terminal.sessionId).toBe(terminal.sessionId);
    expect(f.ptys).toHaveLength(2);
  });

  it("will not start again below Full access, in a room, for an unseen conversation, or for a card that is not there", async () => {
    const f = await fixture();
    const id = (await f.call(DIRECT, "open")).payload.session_id as string;
    f.ptys[0]!.end(0);
    const path = `/api/threads/thread-1/terminal/${id}/restart`;
    f.state.approval = "ask";
    const lowered = await f.http("POST", path);
    expect(lowered.status).toBe(403);
    expect(lowered.body.error).toBe(TERMINAL_MESSAGES.needsFullAccess);
    f.state.approval = "full";
    expect((await f.http("POST", "/api/threads/room-1/terminal/x/restart")).status).toBe(404);
    f.state.visible.add("room-1");
    expect((await f.http("POST", "/api/threads/room-1/terminal/x/restart")).status).toBe(403);
    expect((await f.http("POST", "/api/threads/thread-2/terminal/" + id + "/restart")).status).toBe(404);
    expect((await f.http("GET", path)).status).toBe(405);
    f.state.visible.delete("thread-1");
    expect((await f.http("POST", path)).status).toBe(404);
    expect(f.ptys).toHaveLength(1);
  });
});
