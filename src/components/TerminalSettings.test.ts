// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_LIMITS } from "../../shared/terminal";

const fixture = vi.hoisted(() => ({
  config: { terminal: { maxPerThread: 3, maxTotal: 12, shellIntegration: true } } as { terminal?: Record<string, unknown> },
  calls: [] as Array<{ path: string; method: string; body: unknown }>,
  dispatched: [] as unknown[],
}));
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: { config: fixture.config }, dispatch: (action: unknown) => fixture.dispatched.push(action) }),
  api: async (path: string, init: { method: string; body: string }) => {
    const body = JSON.parse(init.body);
    fixture.calls.push({ path, method: init.method, body });
    return { terminal: { maxPerThread: 3, maxTotal: 12, shellIntegration: true, ...body.terminal } };
  },
}));
import { TerminalSettings, parseTerminalLimit, terminalSettings } from "./TerminalSettings";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.config = { terminal: { maxPerThread: 3, maxTotal: 12, shellIntegration: true } };
  fixture.calls = [];
  fixture.dispatched = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const field = (id: string) => container.querySelector<HTMLInputElement>(`#${id}`)!;
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
}

describe("terminal limits", () => {
  it("reads 3, 12 and the marker on when the server says nothing", () => {
    expect(terminalSettings(undefined)).toEqual({ maxPerThread: 3, maxTotal: 12, shellIntegration: true });
  });

  it("accepts whole numbers from 1 to the ceiling only", () => {
    expect(parseTerminalLimit("5", TERMINAL_LIMITS.maxPerThreadCeiling)).toBe(5);
    for (const bad of ["0", "-1", "1.5", "", "abc", String(TERMINAL_LIMITS.maxPerThreadCeiling + 1)]) {
      expect(parseTerminalLimit(bad, TERMINAL_LIMITS.maxPerThreadCeiling)).toBeNull();
    }
  });
});

describe("TerminalSettings", () => {
  it("shows the configured values", async () => {
    await act(async () => root.render(createElement(TerminalSettings)));
    expect(field("terminal-maxPerThread").value).toBe("3");
    expect(field("terminal-maxTotal").value).toBe("12");
    expect(container.querySelector<HTMLInputElement>("input[type=checkbox]")!.checked).toBe(true);
  });

  it("saves a changed limit with PUT /api/config", async () => {
    await act(async () => root.render(createElement(TerminalSettings)));
    await type(field("terminal-maxTotal"), "20");
    expect(fixture.calls).toEqual([{ path: "/api/config", method: "PUT", body: { terminal: { maxTotal: 20 } } }]);
    expect(fixture.dispatched).toHaveLength(1);
  });

  it("refuses a limit past the ceiling without sending it", async () => {
    await act(async () => root.render(createElement(TerminalSettings)));
    await type(field("terminal-maxPerThread"), String(TERMINAL_LIMITS.maxPerThreadCeiling + 1));
    expect(fixture.calls).toEqual([]);
    expect(container.querySelector("[role=alert]")!.textContent).toBe(`Enter a whole number from 1 to ${TERMINAL_LIMITS.maxPerThreadCeiling}.`);
  });

  it("saves the marker switch at once", async () => {
    await act(async () => root.render(createElement(TerminalSettings)));
    await act(async () => container.querySelector<HTMLInputElement>("input[type=checkbox]")!.click());
    expect(fixture.calls).toEqual([{ path: "/api/config", method: "PUT", body: { terminal: { shellIntegration: false } } }]);
  });
});
