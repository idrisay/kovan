/**
 * Agents' plan limits (item 108): the 5-hour and weekly windows Claude Code
 * and Codex are metered on, read from what those tools already write on this
 * Mac — never by asking anyone. What is known is kept with its reset time;
 * once a window's reset time has passed, it is shown as reset until newer
 * numbers arrive. Pure, so the parsing and the reset rule are tested here.
 */

export interface LimitWindow {
  /** "5 hours", "Week", "Week · Opus"… */
  label: string;
  /** 0–100. */
  usedPercent: number;
  /** Epoch ms; undefined when the source didn't say. */
  resetsAt?: number;
  /** Set by `settleWindows`: the reset time passed after the numbers were read. */
  reset?: boolean;
}

export interface AgentLimits {
  /** When these numbers were true (the source's own timestamp). */
  asOf: number;
  /** Where they came from, in words: "Codex's session log", "your status line". */
  source: string;
  windows: LimitWindow[];
  /** "Plus", "Max"… when the source names it. */
  plan?: string;
  /** Not this runner's own record: shared by every account (ccstatusline). */
  shared?: boolean;
}

const pct = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : undefined);
const secondsToMs = (value: unknown) => (typeof value === 'number' && value > 0 ? value * 1000 : undefined);
const isoToMs = (value: unknown) => {
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : undefined;
};

function windowLabel(minutes: unknown, fallback: string): string {
  if (minutes === 300) return '5 hours';
  if (minutes === 10080) return 'Week';
  if (typeof minutes === 'number' && minutes > 0) {
    return minutes % 1440 === 0 ? `${minutes / 1440} days` : minutes % 60 === 0 ? `${minutes / 60} hours` : `${minutes} min`;
  }
  return fallback;
}

/**
 * One line of a Codex session log (`~/.codex/sessions/…jsonl`). Codex writes
 * `rate_limits` into its token-count events after every turn:
 * `{ primary: { used_percent, window_minutes, resets_at }, secondary: …, plan_type }`.
 * undefined for any line that doesn't carry them.
 */
export function codexLimitsFromLine(line: string): AgentLimits | undefined {
  if (!line.includes('"rate_limits"')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const find = (o: unknown): Record<string, unknown> | undefined => {
    if (!o || typeof o !== 'object') return undefined;
    const record = o as Record<string, unknown>;
    if (record['rate_limits'] && typeof record['rate_limits'] === 'object') return record['rate_limits'] as Record<string, unknown>;
    for (const value of Object.values(record)) {
      const hit = find(value);
      if (hit) return hit;
    }
    return undefined;
  };
  const limits = find(parsed);
  if (!limits) return undefined;
  const windows: LimitWindow[] = [];
  for (const [key, fallback] of [['primary', '5 hours'], ['secondary', 'Week']] as const) {
    const w = limits[key] as Record<string, unknown> | undefined;
    const used = pct(w?.['used_percent']);
    if (!w || used === undefined) continue;
    const resetsAt = secondsToMs(w['resets_at']);
    windows.push({ label: windowLabel(w['window_minutes'], fallback), usedPercent: used, ...(resetsAt ? { resetsAt } : {}) });
  }
  if (windows.length === 0) return undefined;
  const asOf = isoToMs((parsed as Record<string, unknown>)['timestamp']) ?? Date.now();
  const plan = typeof limits['plan_type'] === 'string' ? capitalise(limits['plan_type']) : undefined;
  return { asOf, source: "Codex's session log", windows, ...(plan ? { plan } : {}) };
}

function capitalise(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

const CLAUDE_BUCKETS: [string, string][] = [
  ['five_hour', '5 hours'], ['seven_day', 'Week'], ['seven_day_opus', 'Week · Opus'], ['seven_day_sonnet', 'Week · Sonnet']
];

/**
 * What Claude Code hands its status line: `rate_limits.five_hour` and
 * `seven_day` (plus per-model weekly buckets), each `{ used_percentage,
 * resets_at }`. Baton's status-line wrapper saves that payload for the
 * Claude sessions it starts; `recordedAt` is when it did.
 */
export function claudeLimitsFromStatusPayload(payload: unknown, recordedAt: number): AgentLimits | undefined {
  const limits = (payload as { rate_limits?: Record<string, unknown> } | undefined)?.rate_limits;
  if (!limits || typeof limits !== 'object') return undefined;
  const windows: LimitWindow[] = [];
  for (const [key, label] of CLAUDE_BUCKETS) {
    const w = limits[key] as Record<string, unknown> | null | undefined;
    const used = pct(w?.['used_percentage'] ?? w?.['utilization']);
    if (!w || used === undefined) continue;
    // A per-model bucket at 0% says nothing the weekly one doesn't.
    if (key.startsWith('seven_day_') && used === 0) continue;
    const resetsAt = secondsToMs(w['resets_at']) ?? isoToMs(w['resets_at']);
    windows.push({ label, usedPercent: used, ...(resetsAt ? { resetsAt } : {}) });
  }
  return windows.length ? { asOf: recordedAt, source: 'Claude Code, from a session in Baton', windows } : undefined;
}

/** ccstatusline's own cache (`~/.cache/ccstatusline/usage.json`), when that
 *  status line is installed — a head start before Baton has recorded any. */
export function claudeLimitsFromCcstatusline(cache: unknown, modifiedAt: number): AgentLimits | undefined {
  if (!cache || typeof cache !== 'object') return undefined;
  const c = cache as Record<string, unknown>;
  const windows: LimitWindow[] = [];
  const add = (label: string, used: unknown, resets: unknown) => {
    const u = pct(used);
    if (u === undefined) return;
    const resetsAt = isoToMs(resets);
    windows.push({ label, usedPercent: u, ...(resetsAt ? { resetsAt } : {}) });
  };
  add('5 hours', c['sessionUsage'], c['sessionResetAt']);
  add('Week', c['weeklyUsage'], c['weeklyResetAt']);
  if (pct(c['weeklyOpusUsage'])) add('Week · Opus', c['weeklyOpusUsage'], c['weeklyResetAt']);
  if (pct(c['weeklySonnetUsage'])) add('Week · Sonnet', c['weeklySonnetUsage'], c['weeklyResetAt']);
  // One cache for whichever Claude account last drew the status line — so
  // for an account Baton hasn't recorded yet it may be another account's.
  return windows.length ? { asOf: modifiedAt, source: 'your status line, last Claude account used', shared: true, windows } : undefined;
}

/**
 * The numbers as they stand at `now`: a window whose reset time has passed
 * since they were read is at 0% again — its next reset is unknown until the
 * agent next reports — rather than showing a stale percentage.
 */
export function settleWindows(limits: AgentLimits, now: number): AgentLimits {
  return {
    ...limits,
    windows: limits.windows.map((w) =>
      w.resetsAt !== undefined && w.resetsAt <= now
        ? { label: w.label, usedPercent: 0, reset: true }
        : w)
  };
}

/** Newest of several readings of the same agent. */
export function newestLimits(...readings: (AgentLimits | undefined)[]): AgentLimits | undefined {
  return readings.filter((r): r is AgentLimits => Boolean(r)).sort((a, b) => b.asOf - a.asOf)[0];
}
