import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { Terminal } from "@xterm/xterm";
import { copyText } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import {
  TERMINAL_CLOSE,
  terminalSocketPath,
  type TerminalClientFrame,
  type TerminalServerFrame,
  type TerminalState,
} from "../../../shared/terminal";
import { openTerminalLink } from "./terminal-links";
import { readTerminalTheme, terminalFontFamily } from "./terminal-theme";

export const TERMINAL_PASTE_CONFIRM_LINES = 3;
export const TERMINAL_RESIZE_DEBOUNCE_MS = 150;
const SCROLLBACK_LINES = 5_000;
const OSC_CLIPBOARD = 52;

export interface TerminalViewHandle {
  copyAll(): Promise<void>;
  stop(): void;
  focus(): void;
}

export interface TerminalStatus {
  state: TerminalState;
  exitCode?: number;
}

export interface TerminalViewProps {
  threadId: string;
  sessionId: string;
  title: string;
  cols: number;
  rows: number;
  handle?: Ref<TerminalViewHandle>;
  onStatus(status: TerminalStatus): void;
  /** The server does not know this session any more (it restarted). */
  onGone(): void;
  /** Called as the view is torn down, with the screen's text, so the card can keep showing it. */
  onSnapshot(text: string): void;
}

type Connection = "connecting" | "live" | "lost";

export function terminalText(term: Pick<Terminal, "buffer">): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.join("\n");
}

let xtermModules: Promise<{ Terminal: typeof import("@xterm/xterm").Terminal; FitAddon: typeof import("@xterm/addon-fit").FitAddon; WebLinksAddon: typeof import("@xterm/addon-web-links").WebLinksAddon }> | null = null;

function loadXterm() {
  xtermModules ??= Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/addon-web-links"),
    import("@xterm/xterm/css/xterm.css"),
  ]).then(([xterm, fit, links]) => ({ Terminal: xterm.Terminal, FitAddon: fit.FitAddon, WebLinksAddon: links.WebLinksAddon }));
  return xtermModules;
}

function socketUrl(threadId: string, sessionId: string): string {
  const { protocol, host } = window.location;
  return `${protocol === "https:" ? "wss:" : "ws:"}//${host}${terminalSocketPath(threadId, sessionId)}`;
}

function parseFrame(raw: unknown): TerminalServerFrame | null {
  if (typeof raw !== "string") return null;
  try {
    const frame = JSON.parse(raw) as Partial<TerminalServerFrame> | null;
    if (!frame || typeof frame !== "object") return null;
    if (frame.t === "o" && typeof frame.data === "string") return frame as TerminalServerFrame;
    if (frame.t === "s" && (frame.state === "running" || frame.state === "exited")) return frame as TerminalServerFrame;
    if (frame.t === "x" && typeof frame.code === "number") return frame as TerminalServerFrame;
  } catch {
    return null;
  }
  return null;
}

export function TerminalView(props: TerminalViewProps) {
  const { threadId, sessionId } = props;
  const host = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [connection, setConnection] = useState<Connection>("connecting");
  const [attempt, setAttempt] = useState(0);

  useImperativeHandle(props.handle, () => ({
    async copyAll() {
      const term = termRef.current;
      if (term && await copyText(terminalText(term)) === "failed") throw new Error("copy failed");
    },
    stop() {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: "c" } satisfies TerminalClientFrame));
    },
    focus() {
      termRef.current?.focus();
    },
  }), []);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    let cleanup = () => {};
    setConnection("connecting");

    void (async () => {
      const { Terminal, FitAddon, WebLinksAddon } = await loadXterm();
      if (disposed) return;

      const term = new Terminal({
        cols: latest.current.cols,
        rows: latest.current.rows,
        scrollback: SCROLLBACK_LINES,
        cursorBlink: true,
        fontSize: 13,
        fontFamily: terminalFontFamily(element),
        theme: readTerminalTheme(element),
        linkHandler: { activate: (_event, uri) => { openTerminalLink(uri); }, allowNonHttpProtocols: false },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon((_event, uri) => { openTerminalLink(uri); }));
      term.parser.registerOscHandler(OSC_CLIPBOARD, () => true);
      term.open(element);
      termRef.current = term;

      const send = (frame: TerminalClientFrame) => {
        const socket = socketRef.current;
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
      };

      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== "keydown") return true;
        const modified = event.ctrlKey || event.metaKey;
        const key = event.key.toLowerCase();
        if (modified && key === "c") {
          if (term.hasSelection()) {
            void copyText(term.getSelection());
            term.clearSelection();
            return false;
          }
          if (event.metaKey) {
            send({ t: "i", data: "\x03" });
            return false;
          }
          return true;
        }
        if (modified && key === "v") return false;
        // Command shortcuts belong to the app, not to the program in the terminal.
        return !event.metaKey;
      });

      const onPaste = (event: ClipboardEvent) => {
        const text = event.clipboardData?.getData("text/plain") ?? "";
        const lines = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").length;
        if (lines <= TERMINAL_PASTE_CONFIRM_LINES) return;
        event.preventDefault();
        event.stopPropagation();
        if (window.confirm(t("terminal.pasteConfirm", { count: lines }))) term.paste(text);
      };
      element.addEventListener("paste", onPaste, true);

      const data = term.onData((input) => send({ t: "i", data: input }));
      const resized = term.onResize(({ cols, rows }) => send({ t: "r", cols, rows }));

      let timer: ReturnType<typeof setTimeout> | undefined;
      const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(() => { if (!disposed) fit.fit(); }, TERMINAL_RESIZE_DEBOUNCE_MS);
      });
      observer?.observe(element);

      const skin = new MutationObserver(() => { term.options.theme = readTerminalTheme(element); });
      skin.observe(document.documentElement, { attributes: true, attributeFilter: ["data-skin", "class"] });

      const socket = new WebSocket(socketUrl(threadId, sessionId));
      socketRef.current = socket;
      let reportedExit = false;
      socket.onopen = () => {
        if (disposed) return;
        setConnection("live");
        fit.fit();
        send({ t: "r", cols: term.cols, rows: term.rows });
      };
      socket.onmessage = (event) => {
        const frame = parseFrame(event.data);
        if (!frame || disposed) return;
        if (frame.t === "o") term.write(frame.data);
        else if (frame.t === "s") latest.current.onStatus({ state: frame.state, ...(frame.exitCode !== undefined ? { exitCode: frame.exitCode } : {}) });
        else {
          reportedExit = true;
          latest.current.onStatus({ state: "exited", exitCode: frame.code });
        }
      };
      socket.onclose = (event) => {
        if (disposed) return;
        if (event.code === TERMINAL_CLOSE.unavailable) latest.current.onGone();
        else if (event.code === TERMINAL_CLOSE.ended) {
          if (!reportedExit) latest.current.onStatus({ state: "exited" });
        } else setConnection("lost");
      };

      cleanup = () => {
        clearTimeout(timer);
        observer?.disconnect();
        skin.disconnect();
        element.removeEventListener("paste", onPaste, true);
        data.dispose();
        resized.dispose();
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.close();
        socketRef.current = null;
        latest.current.onSnapshot(terminalText(term));
        term.dispose();
        termRef.current = null;
      };
    })();

    return () => {
      disposed = true;
      cleanup();
    };
  }, [threadId, sessionId, attempt]);

  return (
    <div className="relative size-full">
      <div ref={host} data-terminal-screen className="size-full overflow-hidden bg-inset px-2 py-1.5" />
      {connection === "lost" && (
        <div role="status" className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-raised/95 px-3 py-1.5 text-[12px] text-ink-secondary">
          <span>{t("terminal.lost")}</span>
          <button type="button" className="rounded-md px-2 py-0.5 text-ink hover:bg-ink/[0.07]" onClick={() => setAttempt((n) => n + 1)}>
            {t("terminal.reconnect")}
          </button>
        </div>
      )}
      {connection === "connecting" && (
        <div aria-hidden="true" className="pointer-events-none absolute right-3 top-2 text-[12px] text-ink-tertiary">{t("terminal.connecting")}</div>
      )}
    </div>
  );
}
