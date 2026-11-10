import { describe, expect, it } from "vitest";

import { OutputRing } from "./ring.ts";

describe("OutputRing", () => {
  it("addresses bytes by their offset in the whole stream", () => {
    const ring = new OutputRing(1_000, 1_000);
    expect(ring.append("hello ")).toBe(0);
    expect(ring.append("world")).toBe(6);
    expect(ring.end).toBe(11);
    expect(ring.slice(6).toString()).toBe("world");
    expect(ring.slice(0).toString()).toBe("hello world");
  });

  it("drops the oldest whole chunks past its byte limit and says where it starts now", () => {
    const ring = new OutputRing(10, 1_000);
    for (const word of ["aaaa", "bbbb", "cccc"]) ring.append(word);
    expect(ring.base).toBe(4);
    expect(ring.slice(0).toString()).toBe("bbbbcccc");
    expect(ring.end).toBe(12);
  });

  it("drops the oldest past its line limit", () => {
    const ring = new OutputRing(1_000, 2);
    for (const line of ["one\n", "two\n", "three\n"]) ring.append(line);
    expect(ring.slice(0).toString()).toBe("two\nthree\n");
  });

  it("keeps the newest chunk even when it alone is over the limit", () => {
    const ring = new OutputRing(4, 1_000);
    ring.append("0123456789");
    expect(ring.slice(0).toString()).toBe("0123456789");
  });

  it("starts a tail on a character boundary", () => {
    const ring = new OutputRing(1_000, 1_000);
    ring.append("aéb");
    const tail = ring.tail(2);
    expect(tail.bytes.toString()).toBe("b");
    expect(tail.seq).toBe(3);
  });
});
