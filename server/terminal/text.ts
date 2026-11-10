// Turns raw PTY bytes into text a model can read, and finds the markers shell integration writes into the stream.

const ESC = "\u001b";
const BEL = "\u0007";
const CSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
const OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g");
const OTHER_ESCAPE = new RegExp(`${ESC}[@-Z\\\\-_]|${ESC}[ -/]+[0-~]|${ESC}[()][A-Za-z0-9]`, "g");
const SHELL_MARK = new RegExp(`${ESC}\\]133;([ABCD])(?:;([^${BEL}${ESC}]*))?(?:${BEL}|${ESC}\\\\)`, "g");
const OPEN_CSI = new RegExp(`^${ESC}\\[[0-?]*[ -/]*[@-~]`);
const OPEN_OSC = new RegExp(`^${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`);
const PARTIAL_ESCAPE_MAX = 64;

/** The index where an escape sequence the stream has only begun starts, or the length when the text ends cleanly. */
export function completeLength(text: string): number {
  const esc = text.lastIndexOf(ESC);
  if (esc < 0 || text.length - esc > PARTIAL_ESCAPE_MAX) return text.length;
  const tail = text.slice(esc);
  if (tail === ESC) return esc;
  if (tail.startsWith(`${ESC}[`)) return OPEN_CSI.test(tail) ? text.length : esc;
  if (tail.startsWith(`${ESC}]`)) return OPEN_OSC.test(tail) ? text.length : esc;
  return text.length;
}

function applyBackspaces(line: string): string {
  if (!line.includes("\b")) return line;
  const out: string[] = [];
  for (const char of line) {
    if (char === "\b") out.pop();
    else out.push(char);
  }
  return out.join("");
}

/** Plain text of a terminal stream: no escape sequences, a carriage return overwrites its line, blank runs collapse. */
export function stripAnsi(raw: string): string {
  const text = raw.replace(OSC, "").replace(CSI, "").replace(OTHER_ESCAPE, "");
  const lines = text.split("\n").map((line) => {
    const visible = line.endsWith("\r") ? line.slice(0, -1) : line;
    return applyBackspaces(visible.slice(visible.lastIndexOf("\r") + 1)).replace(/(?!\t)\p{Cc}/gu, "").replace(/\s+$/, "");
  });
  const out: string[] = [];
  for (const line of lines) {
    if (line === "" && out.at(-1) === "") continue;
    out.push(line);
  }
  return out.join("\n").replace(/^\n+/, "");
}

export interface ShellMark {
  kind: "A" | "B" | "C" | "D";
  /** Exit status carried by a D mark. */
  code?: number;
  /** Index just past the mark in the text it was found in. */
  end: number;
}

export function shellMarks(text: string): ShellMark[] {
  const marks: ShellMark[] = [];
  for (const match of text.matchAll(SHELL_MARK)) {
    const code = match[1] === "D" && match[2] !== undefined && /^-?\d+$/.test(match[2]) ? Number(match[2]) : undefined;
    marks.push({ kind: match[1] as ShellMark["kind"], ...(code === undefined ? {} : { code }), end: match.index + match[0].length });
  }
  return marks;
}

export function lastLines(raw: string, count: number): string {
  return stripAnsi(raw).replace(/\n+$/, "").split("\n").slice(-count).join("\n");
}

/** Keeps the end of `text` within `maxBytes` of UTF-8 and says how many bytes were left out ahead of it. */
export function tailWithinBytes(text: string, maxBytes: number): { text: string; omitted: number } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, omitted: 0 };
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return { text: bytes.subarray(start).toString("utf8"), omitted: start };
}
