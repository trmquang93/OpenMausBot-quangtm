import { openExternalLink } from "@/lib/app-links";

/** http(s) without credentials, the same rule as externalWebUrl in electron/app-permissions.mjs, which main applies again. */
export function terminalLinkUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  return url.toString();
}

export function openTerminalLink(raw: string): boolean {
  const url = terminalLinkUrl(raw);
  if (!url) return false;
  void openExternalLink(url).catch(() => {});
  return true;
}
