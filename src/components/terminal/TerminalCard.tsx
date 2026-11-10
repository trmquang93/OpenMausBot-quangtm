import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Check, Copy, Maximize2, Minimize2, Play, Square } from "lucide-react";
import { api, type Message } from "@/state/store";
import { copyText } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { terminalRestartPath, type TerminalPayload } from "../../../shared/terminal";
import { APP_POOL_LIMITS, createAppPool, useAppPoolSlot, type AppPool } from "../app/app-pool";
import type { TerminalStatus, TerminalViewHandle } from "./TerminalView";

const TerminalView = lazy(() => import("./TerminalView").then((module) => ({ default: module.TerminalView })));

export const TERMINAL_POOL_LIMIT = 4;
export const TERMINAL_HEIGHT = { default: 320, min: 160, max: 900, step: 24 } as const;

export const terminalPool: AppPool = createAppPool({ limit: TERMINAL_POOL_LIMIT });

const heights = new Map<string, number>();
const snapshots = new Map<string, string>();

export function forgetTerminalRows(): void {
  heights.clear();
  snapshots.clear();
}

const clampHeight = (value: number) => Math.max(TERMINAL_HEIGHT.min, Math.min(TERMINAL_HEIGHT.max, Math.round(value)));

function isTerminalPayload(value: unknown): value is TerminalPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<TerminalPayload>;
  return typeof payload.sessionId === "string" && typeof payload.title === "string" && (payload.state === "running" || payload.state === "exited");
}

export function shortCwd(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts.length <= 3 ? cwd : `…/${parts.slice(-2).join("/")}`;
}

const ICON_BUTTON =
  "inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-ink-secondary transition-colors hover:bg-ink/[0.07] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-40";

export function TerminalCard({ threadId, message, pool }: {
  botId?: string;
  botName?: string;
  threadId?: string;
  message: Message;
  pool?: AppPool;
}) {
  const payload = isTerminalPayload(message.terminal) ? message.terminal : null;
  if (!payload) return null;
  return <TerminalCardBody threadId={threadId} messageId={message.id} payload={payload} pool={pool ?? terminalPool} />;
}

function TerminalCardBody({ threadId, messageId, payload, pool }: { threadId?: string; messageId: string; payload: TerminalPayload; pool: AppPool }) {
  const root = useRef<HTMLDivElement | null>(null);
  const view = useRef<TerminalViewHandle | null>(null);
  const [override, setOverride] = useState<TerminalPayload | null>(null);
  const shown = override ?? payload;
  const snapshotKey = `${messageId}:${shown.sessionId}`;
  const [status, setStatus] = useState<{ sessionId: string; value: TerminalStatus } | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState(() => snapshots.get(snapshotKey));
  const [height, setHeight] = useState(() => heights.get(messageId) ?? TERMINAL_HEIGHT.default);
  const heightRef = useRef(height);
  heightRef.current = height;
  const [full, setFull] = useState(false);
  const [copied, setCopied] = useState(false);
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    if (override && payload.sessionId === override.sessionId) setOverride(null);
  }, [payload.sessionId, override]);
  useEffect(() => { setSnapshot(snapshots.get(snapshotKey)); }, [snapshotKey]);

  const live = status?.sessionId === shown.sessionId ? status.value : null;
  const ended = gone === shown.sessionId;
  const state = ended ? "exited" : live?.state ?? shown.state;
  const exitCode = live?.exitCode ?? shown.exitCode;
  const running = state === "running";

  const slot = useAppPoolSlot({ key: `terminal:${messageId}`, target: root, auto: shown.state === "running" && !ended, evict: async () => {}, pool });
  const closeSlot = slot.close;
  useEffect(() => {
    const element = root.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.at(-1)?.isIntersecting === false) closeSlot();
    }, { rootMargin: `${APP_POOL_LIMITS.marginPx}px 0px` });
    observer.observe(element);
    return () => observer.disconnect();
  }, [closeSlot]);
  const mounted = Boolean(threadId) && slot.live && shown.state === "running" && !ended;
  const text = snapshot ?? shown.lastLines ?? "";

  const copyAll = async () => {
    try {
      if (view.current) await view.current.copyAll();
      else if (await copyText(text) === "failed") throw new Error("copy failed");
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  const startAgain = async () => {
    if (!threadId || starting) return;
    setStarting(true);
    setProblem("");
    try {
      const answer = await api<{ terminal?: TerminalPayload }>(terminalRestartPath(threadId, shown.sessionId), { method: "POST" });
      if (isTerminalPayload(answer.terminal)) setOverride(answer.terminal);
    } catch (cause) {
      setProblem(t("terminal.startFailed", { reason: cause instanceof Error ? cause.message : "" }).trim());
    } finally {
      setStarting(false);
    }
  };

  const startDrag = (event: React.PointerEvent) => {
    event.preventDefault();
    const startY = event.clientY;
    const start = heightRef.current;
    const move = (next: PointerEvent) => setHeight(clampHeight(start + next.clientY - startY));
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      heights.set(messageId, heightRef.current);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  const nudge = (event: React.KeyboardEvent) => {
    const delta = event.key === "ArrowUp" ? -TERMINAL_HEIGHT.step : event.key === "ArrowDown" ? TERMINAL_HEIGHT.step : 0;
    if (!delta) return;
    event.preventDefault();
    const next = clampHeight(heightRef.current + delta);
    heights.set(messageId, next);
    setHeight(next);
  };

  const badge = running ? t("terminal.running") : exitCode !== undefined && !ended ? t("terminal.exitedCode", { code: exitCode }) : t("terminal.exited");

  return (
    <div
      ref={root}
      role="group"
      aria-label={t("terminal.aria", { title: shown.title })}
      data-terminal-card={shown.sessionId}
      className={cn(
        "flex w-full flex-col overflow-hidden bg-inset ring-1 ring-composer-ring",
        full ? "fixed inset-0 z-50 rounded-none bg-panel" : "max-w-[760px] rounded-2xl",
      )}
    >
      <div className="flex min-w-0 items-center gap-2 border-b border-hairline/40 px-3 py-1.5">
        <div className="min-w-0 flex-1">
          <div title={shown.title} className="truncate text-[13px] font-semibold leading-5 text-ink"><bdi dir="auto">{shown.title}</bdi></div>
          <div title={shown.cwd} dir="ltr" className="truncate font-mono text-[11px] leading-4 text-ink-tertiary">{shortCwd(shown.cwd)}</div>
        </div>
        <span
          data-terminal-state={state}
          className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium", running ? "bg-success/15 text-success" : "bg-ink/[0.07] text-ink-secondary")}
        >
          {badge}
        </span>
        {mounted && running && (
          <button type="button" className={ICON_BUTTON} onClick={() => view.current?.stop()}>
            <Square aria-hidden="true" size={12} />{t("terminal.stop")}
          </button>
        )}
        <button type="button" className={ICON_BUTTON} onClick={() => void copyAll()} disabled={!mounted && !text}>
          {copied ? <Check aria-hidden="true" size={12} /> : <Copy aria-hidden="true" size={12} />}
          {copied ? t("terminal.copied") : t("terminal.copyAll")}
        </button>
        <button
          type="button"
          className={ICON_BUTTON}
          aria-label={full ? t("terminal.exitFullScreen") : t("terminal.fullScreen")}
          title={full ? t("terminal.exitFullScreen") : t("terminal.fullScreen")}
          aria-pressed={full}
          onClick={() => setFull((value) => !value)}
        >
          {full ? <Minimize2 aria-hidden="true" size={13} /> : <Maximize2 aria-hidden="true" size={13} />}
        </button>
      </div>

      <div className={cn("min-h-0 w-full", full && "flex-1")} style={full ? undefined : { height }}>
        {mounted && threadId ? (
          <Suspense fallback={null}>
            <TerminalView
              threadId={threadId}
              sessionId={shown.sessionId}
              title={shown.title}
              cols={shown.cols}
              rows={shown.rows}
              handle={view}
              onStatus={(value) => setStatus({ sessionId: shown.sessionId, value })}
              onGone={() => setGone(shown.sessionId)}
              onSnapshot={(value) => {
                snapshots.set(snapshotKey, value);
                setSnapshot(value);
              }}
            />
          </Suspense>
        ) : (
          <pre data-terminal-snapshot className="size-full overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[12px] leading-[1.45] text-ink-secondary">
            {text || t("terminal.noOutput")}
          </pre>
        )}
      </div>

      {!running && (
        <div className="flex items-center justify-between gap-2 border-t border-hairline/40 px-3 py-1.5">
          <span role={problem ? "alert" : undefined} className={cn("min-w-0 truncate text-[12px]", problem ? "text-danger" : "text-ink-tertiary")}>
            {problem || t("terminal.ended")}
          </span>
          <button type="button" className={ICON_BUTTON} disabled={starting || !threadId} onClick={() => void startAgain()}>
            <Play aria-hidden="true" size={12} />{starting ? t("terminal.starting") : t("terminal.startAgain")}
          </button>
        </div>
      )}

      {!full && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("terminal.resize")}
          aria-valuemin={TERMINAL_HEIGHT.min}
          aria-valuemax={TERMINAL_HEIGHT.max}
          aria-valuenow={height}
          tabIndex={0}
          onPointerDown={startDrag}
          onKeyDown={nudge}
          className="h-1.5 w-full shrink-0 cursor-row-resize touch-none bg-transparent hover:bg-ink/[0.07] focus-visible:bg-focus/40 focus-visible:outline-none"
        />
      )}
    </div>
  );
}
