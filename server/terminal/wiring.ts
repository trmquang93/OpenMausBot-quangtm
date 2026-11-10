// What the terminal host needs from the server's own state, as the host's narrow dependencies.
import type { ApprovalMode } from "../../shared/approval-mode.ts";
import type { BotRecord, Store } from "../store.ts";
import { botOwner } from "../../shared/bot-owner.ts";
import { ownerOrAdmin, type RequestAuth } from "../request-auth.ts";
import type { Upgrades } from "../routes/upgrades.ts";
import type { TerminalHostDeps } from "./routes.ts";
import { terminalSettings } from "./settings.ts";

export interface TerminalWiring {
  upgrades: Upgrades;
  store: Store;
  cfg: Parameters<typeof terminalSettings>[0];
  connectorThread(botId: string, threadId: string): { group?: unknown } | null;
  approvalModeForTurn(bot: BotRecord, peerInitiated: boolean, threadId: string): ApprovalMode;
  messageFileRootsForThread(botId: string, threadId: string): string[];
  attachmentsDir: string;
  workspaceDir(botId: string): string;
  visibleTo(viewer: unknown): { thread(threadId: string): boolean };
  viewerFor(auth: RequestAuth): unknown;
  sessions: { isLive(sessionId: string): boolean };
}

export function terminalDeps(w: TerminalWiring): TerminalHostDeps {
  const { store } = w;
  return {
    upgrades: w.upgrades,
    settings: () => terminalSettings(w.cfg),
    directBot: (threadId) => (store.groupByThread(threadId) ? null : store.botByThread(threadId)?.id ?? null),
    inRoom: (botId, threadId) => Boolean(w.connectorThread(botId, threadId)?.group),
    approval: (botId, threadId) => {
      const bot = store.projectBotForTask(botId, threadId) ?? store.bot(botId);
      return bot ? w.approvalModeForTurn(bot, false, threadId) : "ask";
    },
    folders: (botId, threadId) => {
      const roots = w.messageFileRootsForThread(botId, threadId).filter((root) => root !== w.attachmentsDir);
      return { roots, cwd: roots[0] ?? w.workspaceDir(botId) };
    },
    canSee: (auth, threadId) => w.visibleTo(w.viewerFor(auth)).thread(threadId),
    canWrite: (auth, threadId) => {
      if (auth.kind === "loopback") return ownerOrAdmin(auth);
      const bot = store.botByThread(threadId);
      const owner = bot ? botOwner(bot) : null;
      return owner === null ? auth.scopes.includes("admin") : owner === auth.session.email?.trim().toLowerCase();
    },
    live: (auth) => auth.kind === "loopback" || w.sessions.isLive(auth.session.id),
    threadLive: (botId, threadId) => {
      const task = store.taskByThread(botId, threadId);
      return task ? task.archivedAt === undefined : store.bot(botId)?.threadId === threadId;
    },
    appendRow: (threadId, row) => store.appendMessage(threadId, row),
    patchRow: (threadId, messageId, patch) => { store.patchMessage(threadId, messageId, patch); },
    findRow: (threadId, sessionId) => store.messagesFor(threadId).find((message) => message.kind === "terminal" && message.terminal?.sessionId === sessionId),
    onChange: (listener) => store.onChange(listener),
  };
}
