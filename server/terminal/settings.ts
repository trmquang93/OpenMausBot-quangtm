import { z } from "zod";

import { TERMINAL_DEFAULTS, TERMINAL_LIMITS, type TerminalSettings } from "../../shared/terminal.ts";

/** The `terminal` section of config.json: sessions per conversation and app-wide, and whether shells emit OSC 133 prompt marks. */
export const terminalConfigSchema = z.object({
  maxPerThread: z.number().int().min(1).max(TERMINAL_LIMITS.maxPerThreadCeiling).optional(),
  maxTotal: z.number().int().min(1).max(TERMINAL_LIMITS.maxTotalCeiling).optional(),
  shellIntegration: z.boolean().optional(),
}).strict();

export function terminalSettings(cfg: { terminal?: TerminalSettings }): Required<TerminalSettings> {
  return {
    maxPerThread: cfg.terminal?.maxPerThread ?? TERMINAL_DEFAULTS.maxPerThread,
    maxTotal: cfg.terminal?.maxTotal ?? TERMINAL_DEFAULTS.maxTotal,
    shellIntegration: cfg.terminal?.shellIntegration ?? TERMINAL_DEFAULTS.shellIntegration,
  };
}
