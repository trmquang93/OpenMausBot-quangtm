// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { terminalLinkUrl } from "./terminal-links";
import { readTerminalTheme, terminalFontFamily } from "./terminal-theme";

describe("terminal theme", () => {
  it("takes its colours from the skin's custom properties", () => {
    const host = document.createElement("div");
    host.style.setProperty("--color-inset", "#101010");
    host.style.setProperty("--color-ink", "rgb(240, 240, 240)");
    host.style.setProperty("--color-danger", "#ff0000");
    document.body.append(host);
    const theme = readTerminalTheme(host);
    expect(theme.background).toBe("#101010");
    expect(theme.foreground).toBe("rgb(240, 240, 240)");
    expect(theme.red).toBe("#ff0000");
    host.remove();
  });

  it("falls back to a monospace stack when the skin names none", () => {
    expect(terminalFontFamily(document.createElement("div"))).toContain("monospace");
  });
});

describe("terminalLinkUrl", () => {
  it.each([
    ["https://example.com/a?b=1", "https://example.com/a?b=1"],
    ["http://localhost:3000", "http://localhost:3000/"],
  ])("lets %s through", (raw, expected) => expect(terminalLinkUrl(raw)).toBe(expected));

  it.each(["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "ssh://host", "https://u:p@example.com/", "not a url", ""])(
    "refuses %s",
    (raw) => expect(terminalLinkUrl(raw)).toBeNull(),
  );
});
