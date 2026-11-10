// The built-in terminal's two ways in. A bot reaches a session through /api/internal/terminal/*, as the conversation
// its capability names. A person reaches it only through the WebSocket of the card in that conversation, whose
// handshake checks the session belongs to the conversation in the path and that the person may see it. No route
// returns terminal content as JSON.
import type { ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { WebSocketServer, type WebSocket } from "ws";

import type { ApprovalMode } from "../../shared/approval-mode.ts";
import { redactSecretsInText } from "../../shared/redact.ts";
import {
  TERMINAL_CLOSE, TERMINAL_DEFAULTS, TERMINAL_LIMITS, TERMINAL_MESSAGES,
  type TerminalClientFrame, type TerminalPayload, type TerminalServerFrame, type TerminalSettings,
} from "../../shared/terminal.ts";
import type { json as sendJson } from "../harness/http.ts";
import { isSameOrigin, type RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";
import type { Upgrades } from "../routes/upgrades.ts";
import type { StoreChange } from "../store.ts";
import { resolveCwd } from "./launch.ts";
import { spawnPty, type PtySpawner } from "./pty.ts";
import { TerminalError, TerminalManager, type Caller, type SessionInfo } from "./session-manager.ts";

const STREAM = /^\/api\/threads\/([^/]+)\/terminal\/([\w-]+)$/;
const RESTART = /^\/api\/threads\/([^/]+)\/terminal\/([\w-]+)\/restart$/;
const INTERNAL = /^\/api\/internal\/terminal\/(open|write|key|read|wait|close|list)$/;
const PING_MS = 10_000;
const RECHECK_MS = 5_000;
const SLOW_CLIENT_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_BYTES = 64 * 1024;
const OMITTED_MARKER = "\u001b[2m[earlier output omitted]\u001b[0m\r\n";

export interface TerminalRow {
  id: string;
  terminal?: TerminalPayload;
}

export interface TerminalHostDeps {
  upgrades: Upgrades;
  /** The `terminal` section of the loaded config. */
  settings(): TerminalSettings;
  /** The bot whose one-to-one conversation this is, or null for a room or an unknown conversation. */
  directBot(threadId: string): string | null;
  /** Whether this conversation is a room the bot belongs to. */
  inRoom(botId: string, threadId: string): boolean;
  /** The conversation's own approval level, as the turn would run it. */
  approval(botId: string, threadId: string): ApprovalMode;
  /** Where a terminal may start: the allowed roots and the folder it starts in by default. */
  folders(botId: string, threadId: string): { roots: string[]; cwd: string };
  canSee(auth: RequestAuth, threadId: string): boolean;
  /** The person owns the conversation, so their keystrokes, resizes and Stop reach the shell; anyone else who sees it only reads. */
  canWrite(auth: RequestAuth, threadId: string): boolean;
  /** The person's sign-in is still valid. */
  live(auth: RequestAuth): boolean;
  /** Whether the conversation still exists and is not archived. */
  threadLive(botId: string, threadId: string): boolean;
  appendRow(threadId: string, row: { role: "bot"; kind: "terminal"; text: string; terminal: TerminalPayload }): TerminalRow;
  patchRow(threadId: string, messageId: string, patch: { terminal: TerminalPayload }): void;
  findRow(threadId: string, sessionId: string): TerminalRow | undefined;
  onChange(listener: (change: StoreChange) => void): () => void;
  spawn?: PtySpawner;
}

export interface InternalTerminalContext {
  method: string;
  path: string;
  res: ServerResponse;
  json: typeof sendJson;
  botId: string;
  threadId: string;
  readBody: () => Promise<unknown>;
}

export interface TerminalHost {
  manager: TerminalManager;
  route: RouteHandler;
  internal(ctx: InternalTerminalContext): Promise<typeof PASS | void>;
  shutdown(): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined);

function payloadOf(info: SessionInfo): TerminalPayload {
  return { sessionId: info.id, title: info.title, cwd: info.cwd, cols: info.cols, rows: info.rows, state: info.state };
}

function titleFrom(value: unknown): string {
  const title = typeof value === "string" ? redactSecretsInText(value).replace(/\s+/g, " ").trim().slice(0, TERMINAL_LIMITS.titleMax) : "";
  return title || "Terminal";
}

export function createTerminalHost(deps: TerminalHostDeps): TerminalHost {
  const rows = new Map<string, { threadId: string; messageId: string; payload: TerminalPayload }>();
  const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_FRAME_BYTES });

  const manager = new TerminalManager({
    spawn: deps.spawn ?? spawnPty,
    limits: () => {
      const settings = deps.settings();
      return { perThread: settings.maxPerThread ?? TERMINAL_DEFAULTS.maxPerThread, total: settings.maxTotal ?? TERMINAL_DEFAULTS.maxTotal };
    },
    shellIntegration: () => deps.settings().shellIntegration ?? TERMINAL_DEFAULTS.shellIntegration,
    threadLive: deps.threadLive,
    onExit: (info, lastOutput) => finishRow(info, lastOutput),
  });

  function finishRow(info: SessionInfo, lastOutput: string): void {
    const row = rows.get(info.id);
    if (!row) return;
    rows.delete(info.id);
    const terminal: TerminalPayload = { ...row.payload, state: "exited", ...(info.exitCode === undefined ? {} : { exitCode: info.exitCode }), ...(lastOutput ? { lastLines: redactSecretsInText(lastOutput) } : {}) };
    try { deps.patchRow(row.threadId, row.messageId, { terminal }); } catch {}
  }

  const unsubscribe = deps.onChange((change) => {
    if (change.type === "thread.deleted") manager.closeThread(change.threadId);
    else if (change.type === "bot.deleted") manager.closeBot(change.botId);
    else if (change.type === "bot") manager.reconcile(change.botId);
    else if (change.type === "group.deleted") manager.reconcile();
  });

  function refusal(botId: string, threadId: string, opening: boolean): { status: number; error: string } | null {
    if (deps.inRoom(botId, threadId)) return { status: 403, error: TERMINAL_MESSAGES.room };
    if (opening && deps.approval(botId, threadId) !== "full") return { status: 403, error: TERMINAL_MESSAGES.needsFullAccess };
    return null;
  }

  function start(botId: string, threadId: string, title: string, requestedCwd: string | undefined, size: { cols?: number; rows?: number }, shell?: string): SessionInfo | { status: number; error: string } {
    const folders = deps.folders(botId, threadId);
    try { mkdirSync(folders.cwd, { recursive: true }); } catch {}
    const cwd = resolveCwd(requestedCwd, folders.roots, folders.cwd);
    if (!cwd.ok) return { status: 400, error: cwd.error };
    try {
      return manager.open({ botId, threadId, title, cwd: cwd.cwd, ...(shell ? { shell } : {}), ...size });
    } catch (error) {
      if (error instanceof TerminalError) return { status: error.code === "unavailable" ? 503 : 429, error: error.message };
      throw error;
    }
  }

  function attachRow(info: SessionInfo, update?: { messageId: string }): string {
    const payload = payloadOf(info);
    try {
      if (update) {
        deps.patchRow(info.threadId, update.messageId, { terminal: payload });
        rows.set(info.id, { threadId: info.threadId, messageId: update.messageId, payload });
        return update.messageId;
      }
      const row = deps.appendRow(info.threadId, { role: "bot", kind: "terminal", text: `Terminal: ${info.title}`, terminal: payload });
      rows.set(info.id, { threadId: info.threadId, messageId: row.id, payload });
      return row.id;
    } catch (error) {
      void manager.close({ botId: info.botId, threadId: info.threadId }, info.id, "kill");
      throw error;
    }
  }

  const internal: TerminalHost["internal"] = async (ctx) => {
    const op = ctx.method === "POST" ? INTERNAL.exec(ctx.path)?.[1] : undefined;
    if (!op) return PASS;
    const { res, json } = ctx;
    const caller: Caller = { botId: ctx.botId, threadId: ctx.threadId };
    const body = await ctx.readBody();
    const args = isRecord(body) ? body : {};
    const blocked = refusal(caller.botId, caller.threadId, op === "open" || op === "write" || op === "key");
    if (blocked) return void json(res, blocked.status, { error: blocked.error });
    const sessionId = typeof args.session_id === "string" ? args.session_id : "";
    try {
      if (op === "open") {
        const title = titleFrom(args.title);
        const started = start(caller.botId, caller.threadId, title, typeof args.cwd === "string" ? args.cwd : undefined, { cols: integer(args.cols), rows: integer(args.rows) }, typeof args.shell === "string" ? args.shell : undefined);
        if ("error" in started) return void json(res, started.status, { error: started.error });
        const messageId = attachRow(started);
        return void json(res, 200, { session_id: started.id, message_id: messageId, title: started.title, cwd: started.cwd, cols: started.cols, rows: started.rows, shell: started.shell, cursor: started.cursor });
      }
      if (op === "list") {
        return void json(res, 200, { sessions: manager.list(caller).map((info) => ({ session_id: info.id, title: info.title, cwd: info.cwd, cols: info.cols, rows: info.rows, state: info.state, cursor: info.cursor, ...(info.exitCode === undefined ? {} : { exit_code: info.exitCode }) })) });
      }
      if (op === "write") {
        if (typeof args.text !== "string") return void json(res, 400, { error: "text: the characters to type." });
        return void json(res, 200, { ok: true, cursor: manager.write(caller, sessionId, args.text, args.submit === true) });
      }
      if (op === "key") {
        return void json(res, 200, { ok: true, cursor: manager.key(caller, sessionId, typeof args.key === "string" ? args.key : "") });
      }
      if (op === "read") {
        const result = manager.read(caller, sessionId, { cursor: integer(args.cursor), maxBytes: integer(args.max_bytes) });
        return void json(res, 200, { output: result.text, cursor: result.cursor, omitted: result.omitted, state: result.state, ...(result.exitCode === undefined ? {} : { exit_code: result.exitCode }) });
      }
      if (op === "wait") {
        let prompt: RegExp | undefined;
        if (typeof args.prompt === "string" && args.prompt !== "") {
          try { prompt = new RegExp(args.prompt.slice(0, 200), "i"); } catch { return void json(res, 400, { error: TERMINAL_MESSAGES.patternInvalid }); }
        }
        const abort = new AbortController();
        res.once("close", () => abort.abort());
        const waited = await manager.wait(caller, sessionId, {
          idleMs: Math.min(TERMINAL_LIMITS.idleMaxMs, Math.max(50, integer(args.idle_ms) ?? TERMINAL_LIMITS.idleDefaultMs)),
          timeoutMs: Math.min(TERMINAL_LIMITS.waitMaxMs, Math.max(100, integer(args.timeout_ms) ?? TERMINAL_LIMITS.waitDefaultMs)),
          ...(prompt ? { prompt } : {}),
          signal: abort.signal,
        });
        return void json(res, 200, { state: waited.state, cursor: waited.cursor, ...(waited.exitCode === undefined ? {} : { exit_code: waited.exitCode }) });
      }
      const closed = await manager.close(caller, sessionId, args.signal === "kill" ? "kill" : "term");
      return void json(res, 200, { ok: true, state: closed.state, ...(closed.exitCode === undefined ? {} : { exit_code: closed.exitCode }) });
    } catch (error) {
      if (error instanceof TerminalError) return void json(res, error.code === "not_owner" ? 404 : error.code === "bad_request" ? 400 : 429, { error: error.message });
      throw error;
    }
  };

  function serve(ws: WebSocket, auth: RequestAuth, threadId: string, sessionId: string): void {
    const send = (frame: TerminalServerFrame) => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > SLOW_CLIENT_BYTES) { ws.close(1013, "slow"); return; }
      ws.send(JSON.stringify(frame));
    };
    const attached = manager.attach(threadId, sessionId, {
      output: (seq, data) => send({ t: "o", seq, data }),
      exit: (code) => { send({ t: "x", code }); ws.close(TERMINAL_CLOSE.ended, "ended"); },
    });
    if (!attached) { ws.close(TERMINAL_CLOSE.unavailable, "unavailable"); return; }
    const { info, snapshot } = attached;
    send({ t: "s", state: info.state, cols: info.cols, rows: info.rows, ...(info.exitCode === undefined ? {} : { exitCode: info.exitCode }), ...(deps.canWrite(auth, threadId) ? {} : { readOnly: true }) });
    if (snapshot.data) send({ t: "o", seq: snapshot.seq, data: (snapshot.omitted > 0 ? OMITTED_MARKER : "") + snapshot.data });
    if (info.state === "exited") { send({ t: "x", code: info.exitCode ?? 0 }); ws.close(TERMINAL_CLOSE.ended, "ended"); }
    let alive = true;
    const ping = setInterval(() => { if (!alive) { ws.terminate(); return; } alive = false; try { ws.ping(); } catch { /* closing */ } }, PING_MS);
    const recheck = setInterval(() => { if (!deps.live(auth) || !deps.canSee(auth, threadId)) ws.close(1008, "signed out"); }, RECHECK_MS);
    ping.unref();
    recheck.unref();
    ws.on("pong", () => { alive = true; });
    ws.on("error", () => ws.terminate());
    ws.on("message", (data, binary) => {
      if (binary) return;
      let frame: TerminalClientFrame;
      try { frame = JSON.parse(String(data)) as TerminalClientFrame; } catch { return; }
      if (!isRecord(frame)) return;
      if ((frame.t === "i" || frame.t === "r" || frame.t === "c") && !deps.canWrite(auth, threadId)) { ws.close(TERMINAL_CLOSE.readOnly, "read only"); return; }
      if (frame.t === "i" && typeof frame.data === "string") manager.type(threadId, sessionId, frame.data);
      else if (frame.t === "r" && typeof frame.cols === "number" && typeof frame.rows === "number") manager.resize(threadId, sessionId, frame.cols, frame.rows);
      else if (frame.t === "c") manager.stopFromPerson(threadId, sessionId);
    });
    ws.once("close", () => { clearInterval(ping); clearInterval(recheck); attached.detach(); });
  }

  const route: RouteHandler = async ({ req, res, path, method, auth, json }) => {
    const restart = RESTART.exec(path);
    const stream = restart ? null : STREAM.exec(path);
    const match = restart ?? stream;
    if (!match) return PASS;
    let threadId: string;
    try { threadId = decodeURIComponent(match[1]!); } catch { return void json(res, 404, { error: "no such conversation" }); }
    const sessionId = match[2]!;
    res.setHeader("cache-control", "no-store");
    if (!isSameOrigin(req)) return void json(res, 403, { error: "forbidden: cross-origin request" });
    if (!deps.canSee(auth, threadId)) return void json(res, 404, { error: "no such conversation" });

    if (stream) {
      if (method !== "GET") return void json(res, 405, { error: "method not allowed" });
      const pending = deps.upgrades.pending(req);
      if (!pending) return void json(res, 426, { error: "WebSocket upgrade required" });
      if (pending.socket.destroyed) return;
      pending.release();
      sockets.handleUpgrade(req, pending.socket, pending.head, (ws) => serve(ws, auth, threadId, sessionId));
      res.detachSocket(pending.socket);
      return;
    }

    if (method !== "POST") return void json(res, 405, { error: "method not allowed" });
    const botId = deps.directBot(threadId);
    if (!botId) return void json(res, 403, { error: TERMINAL_MESSAGES.room });
    const blocked = refusal(botId, threadId, true);
    if (blocked) return void json(res, blocked.status, { error: blocked.error });
    const row = deps.findRow(threadId, sessionId);
    if (!row?.terminal) return void json(res, 404, { error: "no such terminal" });
    if (manager.info(threadId, sessionId)?.state === "running") return void json(res, 409, { error: "That terminal is still running." });
    const started = start(botId, threadId, row.terminal.title, row.terminal.cwd, { cols: row.terminal.cols, rows: row.terminal.rows });
    if ("error" in started) return void json(res, started.status, { error: started.error });
    attachRow(started, { messageId: row.id });
    return void json(res, 200, { terminal: payloadOf(started) });
  };

  function shutdown(): void {
    hosts.delete(host);
    unsubscribe();
    for (const ended of manager.shutdown()) finishRow(ended.info, ended.lastOutput);
    sockets.close();
  }

  deps.upgrades.route((path) => STREAM.test(path));
  const host: TerminalHost = { manager, route, internal, shutdown };
  hosts.add(host);
  hookProcess();
  return host;
}

const hosts = new Set<TerminalHost>();
let hooked = false;

/** SIGINT and SIGTERM end every terminal, and so does any exit, so no shell or spawn-helper outlives the server. */
function hookProcess(): void {
  if (hooked) return;
  hooked = true;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { for (const host of hosts) host.shutdown(); });
  process.on("exit", () => { for (const host of hosts) host.manager.shutdown(); });
}
