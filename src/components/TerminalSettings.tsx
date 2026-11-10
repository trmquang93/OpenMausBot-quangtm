import { useEffect, useRef, useState } from "react";

import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { TERMINAL_DEFAULTS, TERMINAL_LIMITS, type TerminalSettings as TerminalSettingsValue } from "../../shared/terminal";

type Limit = "maxPerThread" | "maxTotal";

const CEILING: Record<Limit, number> = { maxPerThread: TERMINAL_LIMITS.maxPerThreadCeiling, maxTotal: TERMINAL_LIMITS.maxTotalCeiling };

export function parseTerminalLimit(value: string, max: number): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return parsed >= 1 && parsed <= max ? parsed : null;
}

export function terminalSettings(config: { terminal?: TerminalSettingsValue } | null | undefined): Required<TerminalSettingsValue> {
  return {
    maxPerThread: config?.terminal?.maxPerThread ?? TERMINAL_DEFAULTS.maxPerThread,
    maxTotal: config?.terminal?.maxTotal ?? TERMINAL_DEFAULTS.maxTotal,
    shellIntegration: config?.terminal?.shellIntegration ?? TERMINAL_DEFAULTS.shellIntegration,
  };
}

export function TerminalSettings() {
  const { state, dispatch } = useStore();
  const confirmed = terminalSettings(state.config);
  const [values, setValues] = useState<Record<Limit, string>>({ maxPerThread: String(confirmed.maxPerThread), maxTotal: String(confirmed.maxTotal) });
  const [dirty, setDirty] = useState<Limit | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const saveInFlight = useRef(false);

  useEffect(() => {
    if (dirty === null) setValues({ maxPerThread: String(confirmed.maxPerThread), maxTotal: String(confirmed.maxTotal) });
  }, [confirmed.maxPerThread, confirmed.maxTotal, dirty]);

  const save = async (patch: TerminalSettingsValue) => {
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    setSaving(true);
    try {
      const config: ConfigStatus = await api("/api/config", { method: "PUT", body: JSON.stringify({ terminal: patch }) });
      dispatch({ type: "configStatus", config });
      const saved = terminalSettings(config);
      setValues({ maxPerThread: String(saved.maxPerThread), maxTotal: String(saved.maxTotal) });
      setDirty(null);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("settings.terminal.error"));
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };

  const commit = (limit: Limit) => {
    if (dirty !== limit) return;
    const parsed = parseTerminalLimit(values[limit], CEILING[limit]);
    if (parsed === null) {
      setError(t("settings.terminal.range", { max: CEILING[limit] }));
      return;
    }
    void save({ [limit]: parsed });
  };

  const field = (limit: Limit, labelKey: "settings.terminal.perThread" | "settings.terminal.total") => (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`terminal-${limit}`} className="text-[13px] font-medium text-ink">{t(labelKey)}</label>
      <input
        id={`terminal-${limit}`}
        type="number"
        min={1}
        max={CEILING[limit]}
        step={1}
        inputMode="numeric"
        value={values[limit]}
        disabled={saving}
        aria-invalid={Boolean(error) && dirty === limit}
        aria-describedby="terminal-settings-help"
        onChange={(event) => {
          setValues((current) => ({ ...current, [limit]: event.target.value }));
          setDirty(limit);
          setError("");
        }}
        onBlur={() => commit(limit)}
        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
        className="w-[120px] rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] tabular-nums text-ink focus:border-focus focus:outline-none"
      />
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      {field("maxPerThread", "settings.terminal.perThread")}
      {field("maxTotal", "settings.terminal.total")}
      <label className="flex items-center gap-2 text-[13px] text-ink">
        <input
          type="checkbox"
          checked={confirmed.shellIntegration}
          disabled={saving}
          aria-describedby="terminal-settings-help"
          onChange={(event) => void save({ shellIntegration: event.target.checked })}
        />
        {t("settings.terminal.shellIntegration")}
      </label>
      <p id="terminal-settings-help" className="text-[12px] leading-relaxed text-ink-secondary">{t("settings.terminal.help")}</p>
      {error ? <p role="alert" className="text-[12px] text-danger">{error}</p> : null}
    </div>
  );
}
