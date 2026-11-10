// PTY sessions. A session belongs to the one (bot, conversation) that opened it: every call that reaches a session
// names its caller, and a session that is missing and one that is somebody else's are answered the same way.
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";

import { TERMINAL_KEY_BYTES, TERMINAL_LIMITS, TERMINAL_MESSAGES, type TerminalKey, type TerminalState } from "../../shared/terminal.ts";
import { chooseShell, removeLaunchFiles, scrubEnv, shellLaunch } from "./launch.ts";
import type { PtyExit, PtyProcess, PtySpawner } from "./pty.ts";
import { OutputRing } from "./ring.ts";
import { completeLength, lastLines, shellMarks, stripAnsi, tailWithinBytes } from "./text.ts";

export type TerminalErrorCode = "not_owner" | "limit_thread" | "limit_app" | "rate_limit" | "unavailable" | "bad_request";

export class TerminalError extends Error {
  readonly code: TerminalErrorCode;
  constructor(code: TerminalErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Who is calling: taken from the authenticated tool call, never from the model's arguments. */
export interface Caller {
  botId: string;
  threadId: string;
}

export interface SessionInfo {
  id: string;
  botId: string;
  threadId: string;
  title: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  state: TerminalState;
  exitCode?: number;
  /** The offset the next output byte will have. */
  cursor: number;
  createdAt: number;
}

export interface OpenRequest extends Caller {
  title: string;
  /** A folder the caller has already checked against the allowed roots. */
  cwd: string;
  shell?: string;
  cols?: number;
  rows?: number;
}

export interface Subscriber {
  output(seq: number, data: string): void;
  exit(code: number): void;
}

export interface ReadResult {
  text: string;
  cursor: number;
  omitted: number;
  state: TerminalState;
  exitCode?: number;
}

export type WaitState = "done" | "idle" | "prompt" | "exit" | "timeout";

export interface WaitResult {
  state: WaitState;
  cursor: number;
  exitCode?: number;
}

export interface WaitOptions {
  idleMs: number;
  timeoutMs: number;
  prompt?: RegExp;
  signal?: AbortSignal;
}

export interface ManagerOptions {
  spawn: PtySpawner;
  env?: NodeJS.ProcessEnv;
  limits?: () => { perThread: number; total: number };
  shellIntegration?: () => boolean;
  /** Whether the conversation a session was opened in still exists and is not archived. */
  threadLive?: (botId: string, threadId: string) => boolean;
  onExit?: (info: SessionInfo, lastOutput: string) => void;
  now?: () => number;
  idleCloseMs?: number;
  sweepMs?: number;
}

const HANGUP_GRACE_MS = 3_000;
const KILL_GRACE_MS = 8_000;
const CLOSE_WAIT_MS = 2_000;

interface SessionInit {
  id: string;
  botId: string;
  threadId: string;
  title: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  proc: PtyProcess;
  createdAt: number;
}

class Session {
  readonly id: string;
  readonly botId: string;
  readonly threadId: string;
  readonly title: string;
  readonly cwd: string;
  readonly shell: string;
  readonly proc: PtyProcess;
  readonly createdAt: number;
  cols: number;
  rows: number;
  readonly ring = new OutputRing(TERMINAL_LIMITS.ringBytes, TERMINAL_LIMITS.ringLines);
  readonly subscribers = new Set<Subscriber>();
  readonly watchers = new Set<() => void>();
  state: TerminalState = "running";
  exitCode: number | undefined;
  exitedAt = 0;
  lastOutputAt: number;
  lastWriteAt: number;
  lastWriteSeq = 0;
  lastDone: { end: number; code: number } | undefined;
  scanTail = "";
  timers: NodeJS.Timeout[] = [];
  cleanup: string | null = null;
  stopping: Promise<SessionInfo> | undefined;

  constructor(init: SessionInit) {
    this.id = init.id;
    this.botId = init.botId;
    this.threadId = init.threadId;
    this.title = init.title;
    this.cwd = init.cwd;
    this.shell = init.shell;
    this.cols = init.cols;
    this.rows = init.rows;
    this.proc = init.proc;
    this.createdAt = init.createdAt;
    this.lastOutputAt = init.createdAt;
    this.lastWriteAt = init.createdAt;
  }

  info(): SessionInfo {
    return {
      id: this.id, botId: this.botId, threadId: this.threadId, title: this.title, cwd: this.cwd, shell: this.shell,
      cols: this.cols, rows: this.rows, state: this.state, ...(this.exitCode === undefined ? {} : { exitCode: this.exitCode }),
      cursor: this.ring.end, createdAt: this.createdAt,
    };
  }
}

const clamp = (value: number | undefined, min: number, max: number, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;

export class TerminalManager {
  private readonly sessions = new Map<string, Session>();
  private readonly opened = new Map<string, number[]>();
  private readonly options: Required<Pick<ManagerOptions, "env" | "now" | "idleCloseMs" | "sweepMs">> & ManagerOptions;
  private sweeper: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(options: ManagerOptions) {
    this.options = { env: process.env, now: Date.now, idleCloseMs: TERMINAL_LIMITS.idleCloseMs, sweepMs: TERMINAL_LIMITS.sweepMs, ...options };
    this.sweeper = setInterval(() => this.sweep(), this.options.sweepMs);
    this.sweeper.unref();
  }

  private get now(): number {
    return this.options.now();
  }

  private limits() {
    return this.options.limits?.() ?? { perThread: TERMINAL_LIMITS.maxPerThread, total: TERMINAL_LIMITS.maxTotal };
  }

  private owned(caller: Caller, id: string): Session {
    const session = this.sessions.get(id);
    if (!session || session.botId !== caller.botId || session.threadId !== caller.threadId) {
      throw new TerminalError("not_owner", TERMINAL_MESSAGES.notOwner);
    }
    return session;
  }

  private inThread(threadId: string, id: string): Session | undefined {
    const session = this.sessions.get(id);
    return session && session.threadId === threadId ? session : undefined;
  }

  open(request: OpenRequest): SessionInfo {
    if (this.disposed) throw new TerminalError("unavailable", TERMINAL_MESSAGES.unavailable);
    const now = this.now;
    const recent = (this.opened.get(request.threadId) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= TERMINAL_LIMITS.opensPerMinute) throw new TerminalError("rate_limit", TERMINAL_MESSAGES.rateLimit);
    const running = [...this.sessions.values()].filter((session) => session.state === "running");
    const limits = this.limits();
    if (running.filter((session) => session.threadId === request.threadId).length >= limits.perThread) {
      throw new TerminalError("limit_thread", TERMINAL_MESSAGES.threadLimit);
    }
    if (running.length >= limits.total) throw new TerminalError("limit_app", TERMINAL_MESSAGES.appLimit);
    const shell = chooseShell(request.shell, this.options.env);
    if (!shell) throw new TerminalError("unavailable", TERMINAL_MESSAGES.unavailable);
    const cols = clamp(request.cols, TERMINAL_LIMITS.minCols, TERMINAL_LIMITS.maxCols, TERMINAL_LIMITS.defaultCols);
    const rows = clamp(request.rows, TERMINAL_LIMITS.minRows, TERMINAL_LIMITS.maxRows, TERMINAL_LIMITS.defaultRows);
    const integrate = this.options.shellIntegration?.() ?? true;
    const launch = shellLaunch(shell, scrubEnv(this.options.env), integrate && this.options.env.OMB_TERMINAL_SHELL_INTEGRATION !== "0");
    let proc: PtyProcess;
    try {
      proc = this.options.spawn({ file: shell.file, args: launch.args, cwd: request.cwd, env: launch.env, cols, rows });
    } catch {
      removeLaunchFiles(launch.cleanup);
      throw new TerminalError("unavailable", TERMINAL_MESSAGES.unavailable);
    }
    const session = new Session({ id: randomUUID(), botId: request.botId, threadId: request.threadId, title: request.title, cwd: request.cwd, shell: shell.name, cols, rows, proc, createdAt: now });
    session.cleanup = launch.cleanup;
    this.sessions.set(session.id, session);
    this.opened.set(request.threadId, [...recent, now]);
    proc.onData((data) => this.receive(session, data));
    proc.onExit((exit) => this.finished(session, exit));
    return session.info();
  }

  private receive(session: Session, data: string): void {
    const seq = session.ring.append(data);
    session.lastOutputAt = this.now;
    const text = session.scanTail + data;
    const origin = seq - Buffer.byteLength(session.scanTail);
    for (const mark of shellMarks(text)) {
      if (mark.kind === "D") session.lastDone = { end: origin + Buffer.byteLength(text.slice(0, mark.end)), code: mark.code ?? 0 };
    }
    session.scanTail = text.slice(completeLength(text));
    for (const subscriber of session.subscribers) subscriber.output(seq, data);
    this.wake(session);
  }

  private finished(session: Session, exit: PtyExit): void {
    if (session.state === "exited") return;
    session.state = "exited";
    session.exitCode = exit.exitCode !== 0 || !exit.signal ? exit.exitCode : 128 + exit.signal;
    session.exitedAt = this.now;
    for (const timer of session.timers) clearTimeout(timer);
    session.timers = [];
    removeLaunchFiles(session.cleanup);
    session.cleanup = null;
    for (const subscriber of session.subscribers) subscriber.exit(session.exitCode);
    this.wake(session);
    const tail = session.ring.tail(TERMINAL_LIMITS.snapshotBytes).bytes.toString("utf8");
    this.options.onExit?.(session.info(), lastLines(tail, TERMINAL_LIMITS.lastLinesMax));
  }

  private wake(session: Session): void {
    for (const watcher of session.watchers) watcher();
  }

  private input(session: Session, data: string): number {
    if (session.state !== "running") throw new TerminalError("bad_request", TERMINAL_MESSAGES.exited);
    session.lastWriteAt = this.now;
    session.lastWriteSeq = session.ring.end;
    session.proc.write(data);
    return session.lastWriteSeq;
  }

  write(caller: Caller, id: string, text: string, submit = false): number {
    const session = this.owned(caller, id);
    if (Buffer.byteLength(text) > TERMINAL_LIMITS.writeMaxBytes) throw new TerminalError("bad_request", TERMINAL_MESSAGES.writeTooLong);
    return this.input(session, submit ? `${text}\r` : text);
  }

  key(caller: Caller, id: string, key: string): number {
    const session = this.owned(caller, id);
    if (!Object.hasOwn(TERMINAL_KEY_BYTES, key)) throw new TerminalError("bad_request", TERMINAL_MESSAGES.keyUnknown);
    return this.input(session, TERMINAL_KEY_BYTES[key as TerminalKey]);
  }

  read(caller: Caller, id: string, options: { cursor?: number; maxBytes?: number } = {}): ReadResult {
    const session = this.owned(caller, id);
    const maxBytes = clamp(options.maxBytes, 1, TERMINAL_LIMITS.readMaxBytes, TERMINAL_LIMITS.readDefaultBytes);
    const base = session.ring.base;
    const requested = typeof options.cursor === "number" && Number.isFinite(options.cursor) ? Math.max(0, Math.floor(options.cursor)) : 0;
    const from = Math.min(Math.max(requested, base), session.ring.end);
    let bytes = session.ring.slice(from);
    let skip = 0;
    while (skip < bytes.length && (bytes[skip]! & 0xc0) === 0x80) skip += 1;
    bytes = bytes.subarray(skip);
    const raw = bytes.toString("utf8");
    const used = raw.slice(0, completeLength(raw));
    const cursor = session.state === "exited" ? session.ring.end : from + skip + Buffer.byteLength(used);
    const tail = tailWithinBytes(stripAnsi(used), maxBytes);
    const dropped = requested < base ? base - requested : 0;
    return {
      text: tail.text, cursor, omitted: tail.omitted + dropped, state: session.state,
      ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
    };
  }

  wait(caller: Caller, id: string, options: WaitOptions): Promise<WaitResult> {
    const session = this.owned(caller, id);
    const since = session.lastWriteSeq;
    const deadline = this.now + options.timeoutMs;
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const result = (state: WaitState): WaitResult => ({
        state, cursor: session.ring.end, ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
      });
      const finish = (outcome: WaitResult) => {
        if (timer) clearTimeout(timer);
        session.watchers.delete(check);
        options.signal?.removeEventListener("abort", aborted);
        resolve(outcome);
      };
      const evaluate = (): WaitResult | null => {
        if (session.state === "exited") return result("exit");
        if (session.lastDone && session.lastDone.end > since) return { ...result("done"), exitCode: session.lastDone.code };
        if (options.prompt && session.ring.end > since && options.prompt.test(this.lastLine(session))) return result("prompt");
        if (this.now >= Math.max(session.lastOutputAt, session.lastWriteAt) + options.idleMs) return result("idle");
        if (this.now >= deadline) return result("timeout");
        return null;
      };
      function aborted() { finish(result("timeout")); }
      const check = () => {
        if (timer) clearTimeout(timer);
        const outcome = evaluate();
        if (outcome) return finish(outcome);
        const next = Math.min(deadline, Math.max(session.lastOutputAt, session.lastWriteAt) + options.idleMs);
        timer = setTimeout(check, Math.max(1, next - this.now));
      };
      if (options.signal?.aborted) return resolve(result("timeout"));
      options.signal?.addEventListener("abort", aborted, { once: true });
      session.watchers.add(check);
      check();
    });
  }

  private lastLine(session: Session): string {
    const text = stripAnsi(session.ring.tail(4_096).bytes.toString("utf8")).split("\n");
    for (let i = text.length - 1; i >= 0; i -= 1) if (text[i]!.trim() !== "") return text[i]!;
    return "";
  }

  list(caller: Caller): SessionInfo[] {
    return [...this.sessions.values()]
      .filter((session) => session.botId === caller.botId && session.threadId === caller.threadId)
      .map((session) => session.info());
  }

  close(caller: Caller, id: string, signal: "term" | "kill" = "term"): Promise<SessionInfo> {
    return this.stop(this.owned(caller, id), signal);
  }

  private stop(session: Session, signal: "term" | "kill"): Promise<SessionInfo> {
    if (session.state === "exited") return Promise.resolve(session.info());
    if (signal === "term" && session.stopping) return session.stopping;
    const stopped = new Promise<SessionInfo>((resolve) => {
      const exited = () => { if (session.state === "exited") done(); };
      const done = () => { session.watchers.delete(exited); clearTimeout(grace); resolve(session.info()); };
      const grace = setTimeout(done, CLOSE_WAIT_MS);
      session.watchers.add(exited);
      if (signal === "kill") session.proc.kill("SIGKILL");
      else {
        session.proc.kill("SIGHUP");
        session.timers.push(setTimeout(() => session.proc.kill("SIGTERM"), HANGUP_GRACE_MS).unref());
        session.timers.push(setTimeout(() => session.proc.kill("SIGKILL"), KILL_GRACE_MS).unref());
      }
    });
    if (signal === "term") session.stopping = stopped;
    return stopped;
  }

  info(threadId: string, id: string): SessionInfo | undefined {
    return this.inThread(threadId, id)?.info();
  }

  /** A person's view of a session in `threadId`: the newest output so far, then every later byte. */
  attach(threadId: string, id: string, subscriber: Subscriber): { info: SessionInfo; snapshot: { seq: number; data: string; omitted: number }; detach(): void } | undefined {
    const session = this.inThread(threadId, id);
    if (!session) return undefined;
    const tail = session.ring.tail(TERMINAL_LIMITS.snapshotBytes);
    const snapshot = { seq: tail.seq, data: tail.bytes.toString("utf8"), omitted: tail.seq };
    session.subscribers.add(subscriber);
    return { info: session.info(), snapshot, detach: () => { session.subscribers.delete(subscriber); } };
  }

  type(threadId: string, id: string, data: string): void {
    const session = this.inThread(threadId, id);
    if (session?.state === "running" && Buffer.byteLength(data) <= TERMINAL_LIMITS.snapshotBytes) this.input(session, data);
  }

  resize(threadId: string, id: string, cols: number, rows: number): void {
    const session = this.inThread(threadId, id);
    if (session?.state !== "running") return;
    session.cols = clamp(cols, TERMINAL_LIMITS.minCols, TERMINAL_LIMITS.maxCols, session.cols);
    session.rows = clamp(rows, TERMINAL_LIMITS.minRows, TERMINAL_LIMITS.maxRows, session.rows);
    session.proc.resize(session.cols, session.rows);
  }

  stopFromPerson(threadId: string, id: string): void {
    const session = this.inThread(threadId, id);
    if (session) void this.stop(session, "term");
  }

  closeThread(threadId: string): void {
    for (const session of this.sessions.values()) if (session.threadId === threadId) this.drop(session);
  }

  closeBot(botId: string): void {
    for (const session of this.sessions.values()) if (session.botId === botId) this.drop(session);
  }

  /** Closes the sessions, of `botId` or of every bot, whose conversation is gone or archived. */
  reconcile(botId?: string): void {
    const live = this.options.threadLive;
    if (!live) return;
    for (const session of this.sessions.values()) {
      if ((botId === undefined || session.botId === botId) && !live(session.botId, session.threadId)) this.drop(session);
    }
  }

  private drop(session: Session): void {
    this.sessions.delete(session.id);
    if (session.state === "running") void this.stop(session, "term");
  }

  private sweep(): void {
    const now = this.now;
    const live = this.options.threadLive;
    for (const session of this.sessions.values()) {
      if (session.state === "exited") {
        if (now - session.exitedAt > TERMINAL_LIMITS.orphanMs && session.subscribers.size === 0) this.sessions.delete(session.id);
      } else if (live && !live(session.botId, session.threadId)) {
        this.drop(session);
      } else if (session.subscribers.size === 0 && now - Math.max(session.lastOutputAt, session.lastWriteAt) > this.options.idleCloseMs) {
        void this.stop(session, "term");
      }
    }
  }

  /** Ends every session now, so no shell or spawn-helper outlives the server; returns the ones that were still running. */
  shutdown(): Array<{ info: SessionInfo; lastOutput: string }> {
    this.disposed = true;
    if (this.sweeper) clearInterval(this.sweeper);
    const ended: Array<{ info: SessionInfo; lastOutput: string }> = [];
    for (const session of this.sessions.values()) {
      for (const timer of session.timers) clearTimeout(timer);
      if (session.state === "running") {
        const tail = session.ring.tail(TERMINAL_LIMITS.snapshotBytes).bytes.toString("utf8");
        ended.push({ info: { ...session.info(), state: "exited" }, lastOutput: lastLines(tail, TERMINAL_LIMITS.lastLinesMax) });
        session.proc.kill("SIGKILL");
      }
      if (session.cleanup) rmSync(session.cleanup, { recursive: true, force: true });
    }
    this.sessions.clear();
    return ended;
  }
}
