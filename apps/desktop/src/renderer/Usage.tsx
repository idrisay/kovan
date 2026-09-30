/**
 * Token usage in the window: a chip on each session row, a strip in a
 * session's header, a line on a ticket or pull request, and the Usage
 * overview in the Sessions tab.
 *
 * Every number is read by `main/usage.ts` from the agents' own logs. Cost is
 * API-equivalent — what those tokens would cost at list price — and is always
 * labelled that way, since a subscription is not billed per token.
 */

import { useMemo, useState, useSyncExternalStore } from 'react';
import {
  DEFAULT_PRICES,
  cacheHitRate,
  costOf,
  formatAge,
  formatTokens,
  formatUsd,
  mergeModels,
  recordCounts,
  recordMatches,
  totalTokens,
  totalsOf,
  type PriceRule,
  type UsageRecord,
  type UsageTotals
} from '@baton/core';
import { findSubject, type Selection } from './sessionSubject';
import type { Snapshot } from './types';

// --- One shared store, one IPC subscription -------------------------------------------

interface UsageStore {
  records: UsageRecord[];
  prices: PriceRule[];
}

let store: UsageStore = { records: [], prices: DEFAULT_PRICES };
const listeners = new Set<() => void>();
let started = false;

function publish(next: Partial<UsageStore>): void {
  store = { ...store, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!started) {
    started = true;
    void window.baton.usage().then((records) => publish({ records }));
    window.baton.onUsage((records) => publish({ records }));
    void window.baton.settings().then((settings) => publish({ prices: validPrices(settings['usage.prices']) }));
  }
  return () => listeners.delete(listener);
}

export function useUsage(): UsageStore {
  return useSyncExternalStore(subscribe, () => store);
}

/** Settings' price table: anything malformed falls back to the defaults. */
export function validPrices(value: unknown): PriceRule[] {
  if (!Array.isArray(value) || value.length === 0) return DEFAULT_PRICES;
  const ok = value.every((r) =>
    r && typeof r.match === 'string' &&
    ['input', 'output', 'cacheWrite', 'cacheWrite1h', 'cacheRead'].every((k) => typeof r[k] === 'number' && r[k] >= 0));
  return ok ? (value as PriceRule[]) : DEFAULT_PRICES;
}

export function savePrices(prices: PriceRule[] | undefined): void {
  void window.baton.setSetting('usage.prices', prices ?? null);
  publish({ prices: prices ?? DEFAULT_PRICES });
}

// --- Small pieces ---------------------------------------------------------------------

function costText(totals: { usd: number; unpriced: boolean }): string {
  return `${formatUsd(totals.usd)}${totals.unpriced ? '+' : ''}`;
}

function breakdown(record: UsageRecord, prices: PriceRule[]): string {
  return record.models.map((m) => {
    const cost = costOf(m, prices);
    return `${m.model}: ${formatTokens(m.input)} in · ${formatTokens(m.output)} out · ` +
      `${formatTokens(m.cacheWrite + m.cacheWrite1h)} cache write · ${formatTokens(m.cacheRead)} cache read · ` +
      (cost === undefined ? 'no price set' : formatUsd(cost));
  }).join('\n') + '\nAPI-equivalent cost at list prices.';
}

/** A short model name for a strip: `claude-opus-5-5` → `opus-5-5`. */
function shortModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

/** The cost chip on a session row. Nothing until the session has spent something. */
export function SessionUsageChip({ id }: { id: string }) {
  const { records, prices } = useUsage();
  const record = records.find((r) => r.id === id);
  if (!record || record.models.length === 0) return null;
  const totals = totalsOf([record], prices);
  return (
    <span className="usage-chip" title={breakdown(record, prices)}>
      {costText(totals)}
    </span>
  );
}

/** `opus-5-5 · 2.4M tokens · 88% cached · $3.84`, in a session's header. */
export function SessionUsageStrip({ id }: { id: string }) {
  const { records, prices } = useUsage();
  const record = records.find((r) => r.id === id);
  if (!record || record.models.length === 0) return null;
  const counts = recordCounts(record);
  const hit = cacheHitRate(counts);
  const totals = totalsOf([record], prices);
  const lead = record.models[0];
  return (
    <span className="usage-strip" title={breakdown(record, prices)}>
      <span className="mono">{shortModel(lead.model)}{record.models.length > 1 ? ` +${record.models.length - 1}` : ''}</span>
      <span>{formatTokens(totalTokens(counts))} tokens</span>
      {hit !== undefined && <span>{Math.round(hit * 100)}% cached</span>}
      <span className="usage-cost">{costText(totals)}</span>
      {/* Claude's status line shows the whole conversation's cost, including
          earlier terminals it was resumed from (item 111). When that is more
          than this session's, both are shown, so the two numbers agree. */}
      {record.conversationUsd !== undefined && record.conversationUsd - totals.usd > 0.01 && (
        <span
          className="usage-conversation"
          title={`Claude Code's own total for this conversation: ${formatUsd(record.conversationUsd)} — what its status line shows. It includes earlier terminals this conversation was resumed from; ${costText(totals)} is what was spent in this one.`}
        >
          conversation {formatUsd(record.conversationUsd)}
        </span>
      )}
    </span>
  );
}

// --- On a ticket or a pull request ----------------------------------------------------

const KIND_WORD: Record<string, string> = {
  implement: 'Implement', review: 'Review', unblock: 'Unblock', verify: 'Check',
  'pull-summary': 'Summarize', 'ticket-condense': 'Condense', 'pull-review': 'Code review'
};

export function SubjectUsage({ subject }: { subject: string }) {
  const { records, prices } = useUsage();
  const mine = useMemo(() => records.filter((r) => recordMatches(r, subject)), [records, subject]);
  if (mine.length === 0) return null;
  const sessions = mine.filter((r) => r.source !== 'quick');
  const quick = mine.length - sessions.length;
  const totals = totalsOf(mine, prices);
  const kinds = new Map<string, number>();
  for (const r of sessions) kinds.set(KIND_WORD[r.kind ?? ''] ?? 'Terminal', (kinds.get(KIND_WORD[r.kind ?? ''] ?? 'Terminal') ?? 0) + 1);
  const mix = [...kinds].map(([k, n]) => `${k} ×${n}`);
  if (quick > 0) mix.push(`${quick} free quick job${quick === 1 ? '' : 's'}`);

  return (
    <section className="rail-usage">
      <h3>Token usage</h3>
      <div className="rail-usage-body" title="API-equivalent cost at list prices. The Sessions tab's Token usage has the breakdown.">
        <span className="rail-usage-cost">{costText(totals)}</span>
        <span className="quick-card-meta">
          {formatTokens(totalTokens(totals))} tokens · {sessions.length} session{sessions.length === 1 ? '' : 's'}
        </span>
      </div>
      <span className="quick-card-meta">{mix.join(' · ')}</span>
    </section>
  );
}

// --- The overview ---------------------------------------------------------------------

type Range = 'today' | '7d' | '30d' | 'all';
const RANGES: { id: Range; label: string }[] = [
  { id: 'today', label: 'Today' }, { id: '7d', label: '7 days' }, { id: '30d', label: '30 days' }, { id: 'all', label: 'All' }
];

function since(range: Range): number {
  const now = new Date();
  if (range === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (range === '7d') return Date.now() - 7 * 86_400_000;
  if (range === '30d') return Date.now() - 30 * 86_400_000;
  return 0;
}

function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** The overview's own row in the Sessions list. */
export function UsageRow({ selected, onSelect }: { selected: boolean; onSelect: () => void }) {
  const { records, prices } = useUsage();
  const month = useMemo(() => totalsOf(records.filter((r) => r.updatedAt >= since('30d')), prices), [records, prices]);
  return (
    <ul className="rows">
      <li>
        <button type="button" className={selected ? 'row selected' : 'row'} onClick={onSelect}>
          <span className="row-top"><span className="row-title">Token usage</span></span>
          <span className="row-state">
            <span className="state">last 30 days</span>
            <span className="spacer" />
            <span className="usage-chip">{costText(month)}</span>
          </span>
        </button>
      </li>
    </ul>
  );
}

export function UsageOverview({
  snapshot, onOpenSubject, initialSubject
}: {
  snapshot: Snapshot;
  onOpenSubject: (match: Selection) => void;
  initialSubject?: string;
}) {
  const { records, prices } = useUsage();
  const [range, setRange] = useState<Range>('7d');
  const [filter, setFilter] = useState<string | undefined>(initialSubject);

  const inRange = useMemo(() => {
    const from = since(range);
    return records.filter((r) => r.updatedAt >= from && (!filter || recordMatches(r, filter)));
  }, [records, range, filter]);
  const totals: UsageTotals = useMemo(() => totalsOf(inRange, prices), [inRange, prices]);
  const hit = cacheHitRate(totals);

  // The last 14 days, oldest first, always — the bars are the trend, not the range.
  const days = useMemo(() => {
    const out: { key: string; label: string; usd: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000);
      out.push({ key: dayKey(d.getTime()), label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), usd: 0 });
    }
    const byKey = new Map(out.map((d) => [d.key, d]));
    for (const r of records) {
      if (filter && !recordMatches(r, filter)) continue;
      const day = byKey.get(dayKey(r.startedAt));
      if (day) day.usd += totalsOf([r], prices).usd;
    }
    return out;
  }, [records, prices, filter]);
  const peak = Math.max(...days.map((d) => d.usd), 0.01);

  const subjects = useMemo(() => {
    const groups = new Map<string, UsageRecord[]>();
    for (const r of inRange) {
      const key = r.subject ?? '';
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    return [...groups].map(([subject, list]) => ({ subject, list, totals: totalsOf(list, prices) }))
      .sort((a, b) => b.totals.usd - a.totals.usd || totalTokens(b.totals) - totalTokens(a.totals));
  }, [inRange, prices]);

  const models = useMemo(() => mergeModels(inRange.map((r) => r.models)), [inRange]);

  return (
    <div className="detail-shell">
      <div className="detail-scroll">
        <div className="detail usage">
          <header className="detail-head">
            <h2 className="quick-job-title">Token usage{filter ? ` · ${filter}` : ''}</h2>
            <div className="detail-meta">
              <span>API-equivalent cost at list prices. Subscriptions are not billed per token.</span>
            </div>
            <div className="usage-ranges" role="tablist">
              {RANGES.map((r) => (
                <button
                  key={r.id} type="button" role="tab" aria-selected={range === r.id}
                  className={range === r.id ? 'usage-range on' : 'usage-range'}
                  onClick={() => setRange(r.id)}
                >
                  {r.label}
                </button>
              ))}
              {filter && (
                <button type="button" className="link" onClick={() => setFilter(undefined)}>Show everything</button>
              )}
            </div>
          </header>

          <div className="usage-tiles">
            <div className="usage-tile"><span className="quick-card-meta">Cost</span><span className="usage-big">{costText(totals)}</span></div>
            <div className="usage-tile"><span className="quick-card-meta">Tokens</span><span className="usage-big">{formatTokens(totalTokens(totals))}</span></div>
            <div className="usage-tile">
              <span className="quick-card-meta">Cache hits</span>
              <span className="usage-big">{hit === undefined ? '—' : `${Math.round(hit * 100)}%`}</span>
            </div>
          </div>
          {totals.unpriced && (
            <p className="quick-card-meta">"+" means some models have no price. Add them under Settings → Token prices.</p>
          )}

          <section>
            <h3>Cost per day, last 14 days</h3>
            <div className="usage-bars">
              {days.map((d) => (
                <span key={d.key} className="usage-bar" title={`${d.label}: ${formatUsd(d.usd)}`}>
                  <span style={{ height: `${Math.max(d.usd > 0 ? 4 : 0, (d.usd / peak) * 100)}%` }} />
                </span>
              ))}
            </div>
            <div className="usage-bars-axis quick-card-meta">
              <span>{days[0]?.label}</span><span>peak {formatUsd(peak === 0.01 ? 0 : peak)}</span><span>today</span>
            </div>
          </section>

          {inRange.length === 0 ? (
            <p className="quiet">
              Nothing recorded in this range. Usage is read from Claude Code and Codex while they run in a Baton terminal.
            </p>
          ) : (
            <>
              <section>
                <h3>By ticket or pull request</h3>
                <div className="usage-table-wrap">
                  <table className="usage-table">
                    <thead><tr><th>Subject</th><th>Sessions</th><th>Tokens</th><th>Cost</th></tr></thead>
                    <tbody>
                      {subjects.map(({ subject, list, totals: t }) => {
                        const match = subject ? findSubject(subject, snapshot) : undefined;
                        return (
                          <tr key={subject || '-'}>
                            <td>
                              {subject ? (
                                <button type="button" className="link" onClick={() => setFilter(subject)} title="Show only this">
                                  {subject}
                                </button>
                              ) : 'Terminals with no subject'}
                              {match && (
                                <button type="button" className="link usage-open" onClick={() => onOpenSubject(match)}>open</button>
                              )}
                            </td>
                            <td>{list.length}</td>
                            <td>{formatTokens(totalTokens(t))}</td>
                            <td>{costText(t)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>

              <section>
                <h3>By model</h3>
                <div className="usage-table-wrap">
                  <table className="usage-table">
                    <thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cache write</th><th>Cache read</th><th>Cost</th></tr></thead>
                    <tbody>
                      {models.map((m) => {
                        const cost = costOf(m, prices);
                        return (
                          <tr key={m.model}>
                            <td className="mono">{m.model}</td>
                            <td>{formatTokens(m.input)}</td>
                            <td>{formatTokens(m.output)}</td>
                            <td>{formatTokens(m.cacheWrite + m.cacheWrite1h)}</td>
                            <td>{formatTokens(m.cacheRead)}</td>
                            <td>{cost === undefined ? 'no price' : formatUsd(cost)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>

              <section>
                <h3>Sessions</h3>
                <div className="usage-table-wrap">
                  <table className="usage-table">
                    <thead><tr><th>Session</th><th>Agent</th><th>Started</th><th>Tokens</th><th>Cost</th></tr></thead>
                    <tbody>
                      {inRange.slice(0, 100).map((r) => {
                        const t = totalsOf([r], prices);
                        return (
                          <tr key={r.id} title={r.models.length ? breakdown(r, prices) : undefined}>
                            <td>{r.title}</td>
                            <td>{r.runnerName}</td>
                            <td>{formatAge(new Date(r.startedAt).toISOString())}</td>
                            <td>{r.models.length ? formatTokens(totalTokens(t)) : 'not reported'}</td>
                            <td>{r.source === 'quick' ? 'free' : costText(t)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
