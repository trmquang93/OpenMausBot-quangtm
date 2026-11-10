// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/state/store";
import { TERMINAL_CLOSE, terminalRestartPath, terminalSocketPath, type TerminalPayload } from "../../../shared/terminal";

const fake = vi.hoisted(() => ({
  terms: [] as any[],
  fits: [] as any[],
  linkHandlers: [] as Array<(event: unknown, uri: string) => void>,
  opened: [] as string[],
  api: vi.fn(),
}));

vi.mock("@/state/store", () => ({ api: fake.api }));
vi.mock("@/lib/app-links", () => ({ openExternalLink: async (url: string) => { fake.opened.push(url); } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@xterm/xterm", () => {
  class Terminal {
    options: any;
    cols: number;
    rows: number;
    written: string[] = [];
    pasted: string[] = [];
    selection = "";
    disposed = false;
    lines = ["first line", "second line", ""];
    oscHandlers = new Map<number, () => boolean>();
    keyHandler: ((event: Partial<KeyboardEvent>) => boolean) | null = null;
    dataListener: ((data: string) => void) | null = null;
    resizeListener: ((size: { cols: number; rows: number }) => void) | null = null;
    parser = { registerOscHandler: (id: number, handler: () => boolean) => { this.oscHandlers.set(id, handler); return { dispose() {} }; } };
    buffer = { active: { get length() { return 3; }, getLine: (index: number) => ({ translateToString: () => this.lines[index] ?? "" }) } };
    constructor(options: any) {
      this.options = options;
      this.cols = options.cols;
      this.rows = options.rows;
      fake.terms.push(this);
    }
    loadAddon() {}
    open() {}
    write(data: string) { this.written.push(data); }
    onData(listener: (data: string) => void) { this.dataListener = listener; return { dispose() {} }; }
    onResize(listener: (size: { cols: number; rows: number }) => void) { this.resizeListener = listener; return { dispose() {} }; }
    attachCustomKeyEventHandler(handler: (event: Partial<KeyboardEvent>) => boolean) { this.keyHandler = handler; }
    hasSelection() { return this.selection !== ""; }
    getSelection() { return this.selection; }
    clearSelection() { this.selection = ""; }
    paste(text: string) { this.pasted.push(text); }
    focus() {}
    dispose() { this.disposed = true; }
  }
  return { Terminal };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit = vi.fn(); constructor() { fake.fits.push(this); } } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class { constructor(handler: (event: unknown, uri: string) => void) { fake.linkHandlers.push(handler); } } }));

import { createAppPool } from "../app/app-pool";
import { TerminalCard, TERMINAL_POOL_LIMIT, terminalPool } from "./TerminalCard";
import { TERMINAL_PASTE_CONFIRM_LINES, TERMINAL_RESIZE_DEBOUNCE_MS } from "./TerminalView";

class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 1;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  closed = false;
  constructor(readonly url: string) { FakeSocket.all.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; this.readyState = 3; }
  open() { this.onopen?.(); }
  frame(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  end(code: number) { this.onclose?.({ code }); }
}

const payload = (over: Partial<TerminalPayload> = {}): TerminalPayload => ({
  sessionId: "s1", title: "Build", cwd: "/work/projects/app/server", cols: 100, rows: 30, state: "running", ...over,
});
let run = 0;
const row = (id: string, terminal: TerminalPayload | undefined): Message => ({ id: `${id}:${run}`, role: "bot", kind: "terminal", at: 1, ...(terminal ? { terminal } : {}) });

let container: HTMLDivElement;
let root: Root;
let observers: Array<{ callback: IntersectionObserverCallback; element?: Element }>;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function render(...messages: Message[]) {
  await act(async () => root.render(createElement("div", null, messages.map((message) =>
    createElement(TerminalCard, { key: message.id, threadId: "t1", message })))));
  await flush();
}
const button = (label: string) => [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(label) || candidate.getAttribute("aria-label") === label);
const liveSockets = () => FakeSocket.all.filter((socket) => !socket.closed);
const liveTerms = () => fake.terms.filter((term) => !term.disposed);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("ResizeObserver", class { constructor(readonly callback: () => void) { fake.fits.push({ observer: this }); } observe() {} disconnect() {} });
  observers = [];
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { observers.push({ callback }); }
    observe(element: Element) { observers[observers.length - 1]!.element = element; }
    disconnect() {}
  });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => {}) } });
  FakeSocket.all = [];
  fake.terms = [];
  fake.fits = [];
  fake.linkHandlers = [];
  fake.opened = [];
  fake.api.mockReset();
  run += 1;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const enter = async (card = 0, visible = true) => {
  const entries = observers.filter((observer) => observer.element?.getAttribute("data-terminal-card"));
  await act(async () => entries.forEach((observer) => observer.callback([{ isIntersecting: visible, target: observer.element! } as IntersectionObserverEntry], {} as IntersectionObserver)));
  await flush();
  return card;
};

describe("a running terminal", () => {
  it("shows its header and streams the session's WebSocket into xterm", async () => {
    await render(row("m1", payload()));
    await enter();
    const card = container.querySelector<HTMLElement>("[data-terminal-card]")!;
    expect(card.getAttribute("aria-label")).toBe("Terminal: Build");
    expect(card.textContent).toContain("Build");
    expect(card.textContent).toContain("…/app/server");
    expect(card.querySelector("[data-terminal-state]")!.textContent).toBe("Running");
    expect(button("Stop")).toBeTruthy();
    expect(button("Copy all")).toBeTruthy();
    expect(button("Full screen")).toBeTruthy();

    expect(FakeSocket.all).toHaveLength(1);
    expect(FakeSocket.all[0]!.url.endsWith(terminalSocketPath("t1", "s1"))).toBe(true);
    expect(fake.terms[0].options).toMatchObject({ cols: 100, rows: 30 });
    await act(async () => FakeSocket.all[0]!.open());
    expect(FakeSocket.all[0]!.sent).toEqual([]);
    await act(async () => FakeSocket.all[0]!.frame({ t: "s", state: "running", cols: 100, rows: 30 }));
    expect(FakeSocket.all[0]!.sent).toEqual([{ t: "r", cols: 100, rows: 30 }]);

    await act(async () => FakeSocket.all[0]!.frame({ t: "o", seq: 0, data: "hello\r\n" }));
    expect(fake.terms[0].written).toEqual(["hello\r\n"]);
  });

  it("sends keystrokes, Stop and resizes as frames", async () => {
    await render(row("m1", payload()));
    await enter();
    const socket = FakeSocket.all[0]!;
    await act(async () => socket.open());
    await act(async () => socket.frame({ t: "s", state: "running", cols: 100, rows: 30 }));
    await act(async () => fake.terms[0].dataListener("ls\r"));
    await act(async () => fake.terms[0].resizeListener({ cols: 90, rows: 20 }));
    await act(async () => button("Stop")!.click());
    expect(socket.sent).toEqual(expect.arrayContaining([{ t: "i", data: "ls\r" }, { t: "r", cols: 90, rows: 20 }, { t: "c" }]));
  });

  it("sends nothing and takes no input when the server says the viewer only reads", async () => {
    await render(row("m1", payload()));
    await enter();
    const socket = FakeSocket.all[0]!;
    await act(async () => socket.open());
    await act(async () => socket.frame({ t: "s", state: "running", cols: 100, rows: 30, readOnly: true }));
    await act(async () => fake.terms[0].dataListener("ls\r"));
    await act(async () => fake.terms[0].resizeListener({ cols: 90, rows: 20 }));
    await act(async () => button("Stop")!.click());
    expect(socket.sent).toEqual([]);
    expect(fake.terms[0].options.disableStdin).toBe(true);
  });

  it("refits once after a burst of size changes", async () => {
    await render(row("m1", payload()));
    await enter();
    const resize = fake.fits.find((entry) => entry.observer)!.observer as { callback: () => void };
    const fit = fake.fits.find((entry) => entry.fit)!.fit as ReturnType<typeof vi.fn>;
    vi.useFakeTimers();
    resize.callback(); resize.callback(); resize.callback();
    vi.advanceTimersByTime(TERMINAL_RESIZE_DEBOUNCE_MS - 1);
    expect(fit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fit).toHaveBeenCalledTimes(1);
  });

  it("turns the badge to Exited with the code and offers Start again when the program ends", async () => {
    await render(row("m1", payload()));
    await enter();
    await act(async () => FakeSocket.all[0]!.frame({ t: "x", code: 3 }));
    expect(container.querySelector("[data-terminal-state]")!.textContent).toBe("Exited (3)");
    expect(button("Start again")).toBeTruthy();
    expect(button("Stop")).toBeUndefined();
  });

  it("shows Session ended from the saved text, without reconnecting, when the server no longer knows the session", async () => {
    await render(row("m1", payload({ lastLines: "saved tail" })));
    await enter();
    await act(async () => FakeSocket.all[0]!.end(TERMINAL_CLOSE.unavailable));
    expect(FakeSocket.all).toHaveLength(1);
    expect(container.querySelector("[data-terminal-snapshot]")!.textContent).toContain("first line");
    expect(container.querySelector("[data-terminal-state]")!.textContent).toBe("Exited");
    expect(container.textContent).toContain("Session ended");
    expect(button("Start again")).toBeTruthy();
  });

  it("offers a reconnect, and only on request, after an unexpected drop", async () => {
    await render(row("m1", payload()));
    await enter();
    await act(async () => FakeSocket.all[0]!.end(1006));
    expect(FakeSocket.all).toHaveLength(1);
    await act(async () => button("Reconnect")!.click());
    await flush();
    expect(FakeSocket.all).toHaveLength(2);
  });
});

describe("an exited terminal", () => {
  it("opens no socket, shows its last lines, and Start again posts to the restart route", async () => {
    await render(row("m1", payload({ state: "exited", exitCode: 0, lastLines: "done\nbye" })));
    await enter();
    expect(FakeSocket.all).toHaveLength(0);
    expect(container.querySelector("[data-terminal-snapshot]")!.textContent).toBe("done\nbye");
    expect(container.querySelector("[data-terminal-state]")!.textContent).toBe("Exited (0)");

    fake.api.mockResolvedValue({ terminal: payload({ sessionId: "s2", title: "Build" }) });
    await act(async () => button("Start again")!.click());
    await flush();
    expect(fake.api).toHaveBeenCalledWith(terminalRestartPath("t1", "s1"), { method: "POST" });
    await enter();
    expect(FakeSocket.all).toHaveLength(1);
    expect(FakeSocket.all[0]!.url.endsWith(terminalSocketPath("t1", "s2"))).toBe(true);
    expect(container.querySelector("[data-terminal-state]")!.textContent).toBe("Running");
  });

  it("says why a restart failed", async () => {
    await render(row("m1", payload({ state: "exited" })));
    fake.api.mockRejectedValue(new Error("A terminal needs Full access."));
    await act(async () => button("Start again")!.click());
    await flush();
    expect(container.querySelector("[role=alert]")!.textContent).toContain("A terminal needs Full access.");
  });

  it("draws nothing for a row without its payload", async () => {
    await render(row("m1", undefined));
    expect(container.querySelector("[data-terminal-card]")).toBeNull();
  });
});

describe("mounting", () => {
  it(`keeps at most ${TERMINAL_POOL_LIMIT} terminals live and shows the saved text of the one it let go`, async () => {
    expect(TERMINAL_POOL_LIMIT).toBe(4);
    const rows = [1, 2, 3, 4, 5].map((n) => row(`m${n}`, payload({ sessionId: `s${n}`, title: `T${n}` })));
    await render(...rows.slice(0, 4));
    await enter();
    expect(liveTerms()).toHaveLength(4);
    await render(...rows);
    await enter();
    expect(liveSockets()).toHaveLength(4);
    expect(liveTerms()).toHaveLength(4);
    const snapshots = [...container.querySelectorAll("[data-terminal-snapshot]")];
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.textContent).toBe("first line\nsecond line");
    expect(terminalPool.live()).toHaveLength(4);
  });

  it("unmounts a card that scrolls out of view, shows its text, and reopens the socket when it returns", async () => {
    await render(row("m1", payload()));
    await enter();
    expect(liveSockets()).toHaveLength(1);
    await enter(0, false);
    expect(liveSockets()).toHaveLength(0);
    expect(container.querySelector("[data-terminal-snapshot]")!.textContent).toBe("first line\nsecond line");
    await enter(0, true);
    expect(liveSockets()).toHaveLength(1);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("uses a pool of its own when given one", async () => {
    const pool = createAppPool({ limit: 1 });
    await act(async () => root.render(createElement("div", null, ["a", "b"].map((id) =>
      createElement(TerminalCard, { key: id, threadId: "t1", message: row(id, payload({ sessionId: id })), pool })))));
    await flush();
    await enter();
    expect(pool.live()).toHaveLength(1);
  });
});

describe("keyboard, clipboard and links", () => {
  async function mounted() {
    await render(row("m1", payload()));
    await enter();
    const socket = FakeSocket.all[0]!;
    await act(async () => socket.open());
    await act(async () => socket.frame({ t: "s", state: "running", cols: 100, rows: 30 }));
    socket.sent.length = 0;
    return { socket, term: fake.terms[0] };
  }

  it("copies a selection on Ctrl/Cmd+C and lets Ctrl+C reach the program", async () => {
    const { socket, term } = await mounted();
    term.selection = "picked";
    expect(term.keyHandler({ type: "keydown", key: "c", ctrlKey: true })).toBe(false);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("picked");
    expect(term.selection).toBe("");

    expect(term.keyHandler({ type: "keydown", key: "c", ctrlKey: true })).toBe(true);
    expect(socket.sent.filter((frame) => frame.t === "i")).toEqual([]);
  });

  it("does not turn Cmd+C without a selection into Ctrl+C", async () => {
    const { socket, term } = await mounted();
    expect(term.keyHandler({ type: "keydown", key: "c", metaKey: true, ctrlKey: false })).toBe(false);
    expect(term.keyHandler({ type: "keydown", key: "c", metaKey: false, ctrlKey: true })).toBe(true);
    expect(socket.sent).toEqual([]);
  });

  it("leaves other Command shortcuts to the app", async () => {
    const { term } = await mounted();
    expect(term.keyHandler({ type: "keydown", key: "k", metaKey: true })).toBe(false);
    expect(term.keyHandler({ type: "keydown", key: "r", ctrlKey: true })).toBe(true);
  });

  it(`asks before pasting more than ${TERMINAL_PASTE_CONFIRM_LINES} lines`, async () => {
    const { term } = await mounted();
    const screen = container.querySelector("[data-terminal-screen]")!;
    const paste = (text: string) => {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
      screen.dispatchEvent(event);
      return event;
    };
    const confirm = vi.fn();
    vi.stubGlobal("confirm", confirm);
    window.confirm = confirm;

    confirm.mockReturnValue(false);
    expect(paste("a\nb\nc\nd\ne").defaultPrevented).toBe(true);
    expect(confirm).toHaveBeenCalledWith("Paste 5 lines into the terminal? Each line may run as a command.");
    expect(term.pasted).toEqual([]);

    confirm.mockReturnValue(true);
    paste("a\nb\nc\nd\ne");
    expect(term.pasted).toEqual(["a\nb\nc\nd\ne"]);

    confirm.mockClear();
    expect(paste("a\nb\nc").defaultPrevented).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("swallows OSC 52 clipboard writes", async () => {
    const { term } = await mounted();
    expect(term.oscHandlers.get(52)!()).toBe(true);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("opens only web links, through the app's link policy", async () => {
    const { term } = await mounted();
    const detected = fake.linkHandlers[0]!;
    detected({}, "javascript:alert(1)");
    detected({}, "file:///etc/passwd");
    detected({}, "https://user:secret@example.com/");
    term.options.linkHandler.activate({}, "data:text/html,x");
    expect(fake.opened).toEqual([]);
    detected({}, "https://example.com/docs");
    term.options.linkHandler.activate({}, "http://localhost:3000/");
    expect(fake.opened).toEqual(["https://example.com/docs", "http://localhost:3000/"]);
  });

  it("copies the whole screen text", async () => {
    await mounted();
    await act(async () => button("Copy all")!.click());
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("first line\nsecond line");
  });
});

describe("size", () => {
  it("remembers a dragged height per message and keeps it across a remount", async () => {
    await render(row("m1", payload()));
    const handle = () => container.querySelector<HTMLElement>("[role=separator]")!;
    expect(handle().getAttribute("aria-valuenow")).toBe("320");
    await act(async () => handle().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(handle().getAttribute("aria-valuenow")).toBe("344");
    await act(async () => root.render(createElement("div")));
    await render(row("m1", payload()));
    expect(handle().getAttribute("aria-valuenow")).toBe("344");
    await render(row("m2", payload({ sessionId: "s9" })));
    expect(handle().getAttribute("aria-valuenow")).toBe("320");
  });

  it("toggles full screen in place without remounting the terminal", async () => {
    await render(row("m1", payload()));
    await enter();
    const before = fake.terms.length;
    await act(async () => button("Full screen")!.click());
    expect(container.querySelector("[data-terminal-card]")!.className).toContain("fixed inset-0");
    expect(button("Exit full screen")).toBeTruthy();
    expect(fake.terms).toHaveLength(before);
  });
});
