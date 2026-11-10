import { expect, it } from "vitest";
import type { Message } from "@/state/store";
import { richRowKind } from "../RichMessageRow";

const row = (over: Partial<Message>): Message => ({ id: "m", role: "bot", kind: "terminal", at: 1, ...over });

it("draws a terminal row as a terminal only when it carries its payload", () => {
  const terminal = { sessionId: "s", title: "T", cwd: "/w", cols: 80, rows: 24, state: "running" as const };
  expect(richRowKind(row({ terminal }))).toBe("terminal");
  expect(richRowKind(row({ text: "fallback" }))).toBe("text");
});
