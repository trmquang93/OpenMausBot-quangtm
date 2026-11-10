import { describe, expect, it } from "vitest";

import type { RequestAuth } from "../request-auth.ts";
import type { Store } from "../store.ts";
import { terminalDeps, type TerminalWiring } from "./wiring.ts";

const loopback = (trust?: "service") => ({ kind: "loopback", scopes: trust ? ["client"] : ["admin", "client"], ...(trust ? { trust } : {}) }) as RequestAuth;
const session = (email: string, admin = false) => ({ kind: "session", via: "cookie", scopes: admin ? ["admin", "client"] : ["client"], session: { id: "s", email } }) as unknown as RequestAuth;

function canWrite(auth: RequestAuth, bot: { createdBy?: string } | undefined) {
  const store = { botByThread: () => bot } as unknown as Store;
  return terminalDeps({ store } as unknown as TerminalWiring).canWrite(auth, "thread-1");
}

describe("who may type into a terminal", () => {
  it("lets the person on a single-user install, and an admin, write", () => {
    expect(canWrite(loopback(), { createdBy: "owner@example.com" })).toBe(true);
    expect(canWrite(loopback(), undefined)).toBe(true);
    expect(canWrite(session("boss@example.com", true), { createdBy: "owner@example.com" })).toBe(true);
  });

  it("lets a member write only in their own bot's conversation", () => {
    expect(canWrite(session("Owner@Example.com"), { createdBy: "owner@example.com" })).toBe(true);
    expect(canWrite(session("viewer@example.com"), { createdBy: "owner@example.com" })).toBe(false);
    expect(canWrite(session("viewer@example.com"), { })).toBe(false);
    expect(canWrite(session("viewer@example.com"), undefined)).toBe(false);
  });

  it("keeps a local service, which a bot's own shell can be, read-only", () => {
    expect(canWrite(loopback("service"), { createdBy: "owner@example.com" })).toBe(false);
  });
});
