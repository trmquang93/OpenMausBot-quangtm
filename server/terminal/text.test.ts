import { describe, expect, it } from "vitest";

import { completeLength, lastLines, shellMarks, stripAnsi, tailWithinBytes } from "./text.ts";

describe("stripAnsi", () => {
  it("removes colour, cursor and title sequences and keeps the words", () => {
    expect(stripAnsi("\u001b[1;32mok\u001b[0m \u001b]0;title\u0007done\u001b[2K")).toBe("ok done");
  });

  it("lets a carriage return overwrite its line, as a progress bar does", () => {
    expect(stripAnsi("10%\r50%\r100%\nnext")).toBe("100%\nnext");
    expect(stripAnsi("line one\r\nline two\r\n")).toBe("line one\nline two\n");
  });

  it("applies backspaces and drops other control characters", () => {
    expect(stripAnsi("ab\bc\u0000\u0007")).toBe("ac");
  });

  it("collapses runs of blank lines", () => {
    expect(stripAnsi("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("never lets an escape byte through", () => {
    expect(stripAnsi("x\u001b]52;c;aGVsbG8=\u0007y\u001b[?1049hz\u001bMw")).not.toContain("\u001b");
  });
});

describe("completeLength", () => {
  it("holds back an escape sequence the stream has only begun", () => {
    expect(completeLength("text\u001b[3")).toBe(4);
    expect(completeLength("text\u001b]133;D;0")).toBe(4);
    expect(completeLength("text\u001b")).toBe(4);
  });

  it("keeps a finished sequence", () => {
    const done = "text\u001b[0m";
    expect(completeLength(done)).toBe(done.length);
  });
});

describe("shellMarks", () => {
  it("reads prompt marks with either terminator and the exit status of D", () => {
    const text = "\u001b]133;A\u0007$ ls\u001b]133;C\u0007out\u001b]133;D;2\u001b\\";
    expect(shellMarks(text).map((mark) => [mark.kind, mark.code])).toEqual([["A", undefined], ["C", undefined], ["D", 2]]);
    expect(text.slice(0, shellMarks(text).at(-1)!.end)).toBe(text);
  });
});

describe("limits", () => {
  it("keeps the newest bytes on a character boundary and counts what went", () => {
    const tail = tailWithinBytes("aé".repeat(10), 7);
    expect(Buffer.byteLength(tail.text)).toBeLessThanOrEqual(7);
    expect(tail.text.endsWith("é")).toBe(true);
    expect(tail.omitted).toBe(Buffer.byteLength("aé".repeat(10)) - Buffer.byteLength(tail.text));
  });

  it("returns the last lines of a stream without its escapes", () => {
    expect(lastLines("\u001b[1mone\u001b[0m\ntwo\nthree\n", 2)).toBe("two\nthree");
  });
});
