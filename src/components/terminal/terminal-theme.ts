import type { ITheme } from "@xterm/xterm";

const FALLBACK = {
  background: "#1b1b1b",
  foreground: "#f5f5f5",
  muted: "#a8a8a8",
  accent: "#7fc0ff",
  accentBorder: "#459ffe",
  success: "#38d591",
  danger: "#ff5667",
  warning: "#ff9800",
  purple: "#8d69ce",
  cyan: "#0ea5c6",
};

/** The skin's tokens as xterm colours: xterm cannot parse var() or colour-mix(), so each is resolved through a probe. */
function resolve(host: HTMLElement, variable: string, fallback: string): string {
  const probe = host.ownerDocument.createElement("span");
  probe.style.color = `var(${variable})`;
  probe.style.display = "none";
  host.append(probe);
  const value = host.ownerDocument.defaultView?.getComputedStyle(probe).color ?? "";
  probe.remove();
  return /^(#|rgb)/i.test(value) ? value : fallback;
}

export function readTerminalTheme(host: HTMLElement): ITheme {
  const c = (variable: string, fallback: string) => resolve(host, variable, fallback);
  const background = c("--color-inset", FALLBACK.background);
  const foreground = c("--color-ink", FALLBACK.foreground);
  const muted = c("--color-ink-secondary", FALLBACK.muted);
  const accent = c("--color-accent-text", FALLBACK.accent);
  const success = c("--color-success", FALLBACK.success);
  const danger = c("--color-danger", FALLBACK.danger);
  const warning = c("--color-warning", FALLBACK.warning);
  const purple = c("--identity-purple", FALLBACK.purple);
  const cyan = c("--identity-cyan", FALLBACK.cyan);
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: c("--color-accent-border", FALLBACK.accentBorder),
    black: background,
    red: danger,
    green: success,
    yellow: warning,
    blue: accent,
    magenta: purple,
    cyan,
    white: muted,
    brightBlack: c("--color-ink-tertiary", FALLBACK.muted),
    brightRed: danger,
    brightGreen: success,
    brightYellow: warning,
    brightBlue: accent,
    brightMagenta: purple,
    brightCyan: cyan,
    brightWhite: foreground,
  };
}

export function terminalFontFamily(host: HTMLElement): string {
  const value = host.ownerDocument.defaultView?.getComputedStyle(host).getPropertyValue("--font-mono").trim();
  return value || 'ui-monospace, Menlo, Consolas, "Liberation Mono", monospace';
}
