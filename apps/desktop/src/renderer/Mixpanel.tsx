/**
 * The Mixpanel tab (item 177, design A with a Discuss panel:
 * https://claude.ai/artifact/DMNBYzgcqQTDka47PE4FUK).
 *
 * Off until Settings › Connections › Mixpanel › "Show Mixpanel in the rail".
 * The sidebar lists saved reports (pinned, then by dashboard); a report opens
 * with its chart, its numbers as a table and the notes kept on it. Discuss
 * opens a panel beside it where a model answers questions from the report's
 * numbers and may ask Kovan for a few read-only queries of its own.
 *
 * Nothing here polls. The list is asked for once (main keeps it until
 * Reload), numbers when you pick a report (main reuses them for 15 minutes),
 * the model only on Ask. Coming back to the tab asks for nothing: what was
 * on screen is kept in `memory` and shown again as it was.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  describeMixpanelQuery, formatChange, formatMetric, groupMixpanelReports, headline, lastPeriodOpen, mixpanelReportUrl,
  parseReviewToolModel, reviewToolLabel,
  type DiscussMessage, type MixpanelReport, type MixpanelResult, type MixpanelSeries
} from '@kovan/core';
import type { MixpanelReportList, MixpanelStatus } from '../main/mixpanel';
import { useMenuDismiss } from './menuDismiss';
import { menuPlace, type MenuPlace } from './menuPlace';
import { QuickModelPicker } from './Quick';
import { OPEN_SETTINGS } from './Reviewers';
import { Resizer, restoreWidth } from './Resizer';
import { GroupHead } from './rows';
import {
  ChartIcon, ChevronIcon, CloseIcon, OpenLinkIcon, PinIcon, PlusIcon, RefreshIcon, SearchIcon, SparklesIcon, TrashIcon
} from './icons';

// --- The rail switch -------------------------------------------------------

let railOn = false;
const railListeners = new Set<() => void>();
void window.kovan.settings().then((settings) => {
  railOn = settings['mixpanel.rail'] === true;
  railListeners.forEach((l) => l());
});

/** Whether the Mixpanel tab is in the rail, re-rendering when Settings changes it. */
export function useMixpanelRail(): boolean {
  return useSyncExternalStore((l) => { railListeners.add(l); return () => railListeners.delete(l); }, () => railOn);
}

export function setMixpanelRail(on: boolean): void {
  railOn = on;
  railListeners.forEach((l) => l());
  void window.kovan.setSetting('mixpanel.rail', on);
}

/**
 * Settings › Connections › Mixpanel, under the fields: Test, which asks
 * Mixpanel for the report list with what was saved (so a wrong secret shows
 * up here, not later in the tab), and the switch that puts the tab in the rail.
 */
export function MixpanelRailSetting({ connected }: { connected: boolean }) {
  const on = useMixpanelRail();
  const [test, setTest] = useState<{ running?: boolean; ok?: boolean; text?: string }>({});
  async function runTest() {
    setTest({ running: true });
    const status = await window.kovan.mixpanelStatus();
    if (!status.connected) {
      setTest({ ok: false, text: `Save these first. Still missing: ${(status.missing ?? []).join(', ')}.` });
      return;
    }
    if (status.problem) {
      setTest({ ok: false, text: status.problem });
      return;
    }
    const list = await window.kovan.mixpanelReports(true);
    setTest(list.error
      ? { ok: false, text: list.error }
      : { ok: true, text: `Connected to project ${status.projectId}: ${list.reports.length} saved report${list.reports.length === 1 ? '' : 's'}.` });
  }
  return (
    <>
      <div className="mp-test-row">
        <button type="button" className="ghost" disabled={test.running} onClick={() => void runTest()}>
          {test.running ? 'Testing…' : 'Test connection'}
        </button>
        {test.text && <span className={test.ok ? 'settings-note ok' : 'settings-note error'}>{test.text}</span>}
      </div>
      <label className="checkbox-row">
        <input type="checkbox" checked={on} onChange={(e) => setMixpanelRail(e.target.checked)} />
        <span>Show Mixpanel in the rail</span>
      </label>
      {on && !connected && (
        <p className="settings-note error">The tab is on, but Mixpanel isn't connected yet: fill in the fields above and Save.</p>
      )}
      <p className="settings-note">
        Off by default. While it is off, Kovan asks Mixpanel nothing. Kovan only reads: saved reports, their numbers,
        and the queries Discuss runs. Turning it off keeps your pins and notes.
      </p>
    </>
  );
}

// --- Setting it up ---------------------------------------------------------

/** Opens Settings at Connections, scrolled to the Mixpanel card. */
export function openMixpanelSettings(): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS, { detail: 'connections:Mixpanel' }));
}

/** Where each value comes from, by its settings key. Shown in the tab and in Settings. */
const FIELD_HELP: Record<string, string> = {
  'mixpanel.region': 'eu when your Mixpanel address starts with eu.mixpanel.com, us for mixpanel.com, in for in.mixpanel.com.',
  'mixpanel.projectId': 'The number after /project/ in the address of any report in that project.',
  'mixpanel.username': 'In Mixpanel: Organization settings › Service accounts › Add service account. Give it access to this project; the Consumer role is enough to read.',
  mixpanel: 'Shown once, when the service account is created. Kovan keeps it in the Keychain and never shows it again.'
};

/** Settings › Connections › Mixpanel, above its fields: what to fill in and where to find it. */
export function MixpanelHelp() {
  return (
    <div className="mp-help">
      <p className="settings-note">
        Kovan reads your saved Mixpanel reports with a service account. It never writes to Mixpanel and sends nothing
        about Kovan there.
      </p>
      <ul>
        <li><b>Data region:</b> {FIELD_HELP['mixpanel.region']}</li>
        <li><b>Project ID:</b> {FIELD_HELP['mixpanel.projectId']}</li>
        <li><b>Service account:</b> {FIELD_HELP['mixpanel.username']} {FIELD_HELP['mixpanel']}</li>
      </ul>
    </div>
  );
}

const FIELD_LABELS: Record<string, string> = {
  'mixpanel.region': 'Data region',
  'mixpanel.projectId': 'Project ID',
  'mixpanel.username': 'Service account username',
  mixpanel: 'Service account secret'
};

/**
 * What the tab shows until Mixpanel can be asked: every value it needs, each
 * ticked or marked missing, where to find it, and one button to the place
 * to fill it in. Also used when Mixpanel refused the account, so a wrong
 * secret reads as something to fix, not as an empty list.
 */
function MixpanelSetup({ status, refused }: { status: MixpanelStatus; refused?: string }) {
  const [labels, setLabels] = useState<{ key: string; label: string }[]>([]);
  useEffect(() => {
    void window.kovan.credentialFields().then((all) => setLabels((all['mixpanel'] ?? []).map((f) => ({ key: f.key, label: f.label }))));
  }, []);
  const missing = new Set(status.missing ?? []);
  const wrong = (key: string) =>
    (key === 'mixpanel.region' && /region/i.test(status.problem ?? '')) ||
    (key === 'mixpanel.projectId' && /project ID/i.test(status.problem ?? ''));
  const title = refused ? 'Mixpanel refused the connection' : status.problem ? 'Mixpanel needs a fix' : 'Connect Mixpanel';
  const lead = refused ?? status.problem ??
    (missing.size === labels.length || labels.length === 0
      ? 'Kovan needs four things from Mixpanel before it can show your reports. It only reads; nothing is written to Mixpanel.'
      : `Almost there: ${missing.size} of ${labels.length} still missing.`);
  return (
    <div className="mp-setup">
      <ChartIcon size={26} />
      <h1>{title}</h1>
      <p className={refused || status.problem ? 'mp-setup-lead problem' : 'mp-setup-lead'}>
        {(refused || status.problem) && <span className="dot fail" />}{lead}
      </p>
      {!refused && labels.length > 0 && (
        <ul className="mp-setup-list">
          {labels.map((f) => {
            const absent = missing.has(f.label);
            const bad = wrong(f.key);
            const state = absent ? 'missing' : bad ? 'fix' : 'done';
            return (
              <li key={f.key} className={state}>
                <span className={`dot ${state === 'done' ? 'pass' : state === 'fix' ? 'fail' : 'idle'}`} />
                <span className="mp-setup-name">{FIELD_LABELS[f.key] ?? f.label}</span>
                <span className="mp-setup-state">{state === 'done' ? 'Added' : state === 'fix' ? 'Needs a fix' : 'Missing'}</span>
                {state !== 'done' && <span className="mp-setup-help">{FIELD_HELP[f.key]}</span>}
              </li>
            );
          })}
        </ul>
      )}
      <button type="button" className="primary" onClick={openMixpanelSettings}>
        {refused || status.problem ? 'Fix in Settings' : 'Open Settings › Mixpanel'}
      </button>
      <p className="mp-setup-foot">Settings › Connections › Mixpanel. The secret is kept in the Keychain.</p>
    </div>
  );
}

// --- What the tab had on screen ----------------------------------------------

/**
 * The tab unmounts when you switch to another one. What it had loaded lives
 * here for the rest of the session, so coming back draws it at once instead
 * of "Loading…" and asks main (and Mixpanel) for nothing.
 */
const memory: {
  status?: MixpanelStatus;
  list?: MixpanelReportList;
  /** Every report's last numbers, once read from main. */
  cached?: Record<string, MixpanelResult>;
  pins?: number[];
  added?: number[];
} = {};

// --- Small helpers ---------------------------------------------------------

const SELECTED_KEY = 'kovan.mixpanel-selected';
const DISCUSS_KEY = 'kovan.mixpanel-discuss';

/**
 * Discuss's width (item 180): dragged from its left edge, kept in
 * `--discuss-w` and remembered across launches. The report keeps at least
 * `REPORT_MIN` beside it; the stylesheet holds the same limits, so a window
 * made smaller later squeezes the panel rather than the report.
 */
const DISCUSS_WIDTH_KEY = 'kovan.mixpanel-discuss-width';
const DISCUSS_MIN = 260;
const REPORT_MIN = 320;
const discussMax = (panel: HTMLElement) =>
  Math.max(DISCUSS_MIN, (panel.parentElement?.getBoundingClientRect().width ?? window.innerWidth) - REPORT_MIN);
restoreWidth('--discuss-w', DISCUSS_WIDTH_KEY, (px) => Math.max(DISCUSS_MIN, Math.round(px)));

function readLocal(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeLocal(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* remembered for this window only */ }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-08-17' → 'Aug 17'; anything else as it is. */
function shortDate(label: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(label);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : label;
}

function age(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

const today = () => new Date().toISOString().slice(0, 10);

// --- Charts ----------------------------------------------------------------

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const step = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * step >= value) return m * step;
  return 10 * step;
}

/** A sparkline for a sidebar row: the shape only, the last point marked. */
function Spark({ points }: { points: { value: number }[] }) {
  if (points.length < 2) return null;
  const max = Math.max(...points.map((p) => p.value), 1);
  const x = (i: number) => 1 + (i * 58) / (points.length - 1);
  const y = (v: number) => 13 - (v / max) * 11;
  const last = points[points.length - 1]!;
  return (
    <svg className="mp-spark" width="60" height="14" viewBox="0 0 60 14" aria-hidden="true">
      <polyline points={points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ')} />
      <circle cx={x(points.length - 1)} cy={y(last.value)} r="1.8" />
    </svg>
  );
}

/**
 * The report's chart. The headline series in the accent with a light area
 * under it; breakdown segments as thin grey lines. A period still running is
 * drawn dashed, as Mixpanel draws it.
 */
function LineChart({ series }: { series: MixpanelSeries[] }) {
  const head = series[0];
  if (!head || head.points.length === 0) return <p className="quiet">No numbers in this period.</p>;
  const W = 640, H = 230, L = 44, R = 12, T = 10, B = 26;
  const all = series.flatMap((s) => s.points.map((p) => p.value));
  const max = niceMax(Math.max(...all));
  const n = head.points.length;
  const x = (i: number) => (n === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (n - 1));
  const y = (v: number) => T + (1 - v / max) * (H - T - B);
  const open = lastPeriodOpen(head.points, today());
  const solid = open ? head.points.slice(0, -1) : head.points;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const labelEvery = Math.max(1, Math.ceil(n / 8));
  const line = (pts: { value: number }[]) => pts.map((p, i) => `${x(i)},${y(p.value)}`).join(' ');
  return (
    <svg className="mp-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${head.name}, ${n} points`}>
      {ticks.map((t) => (
        <g key={t}>
          <line className="grid" x1={L} x2={W - R} y1={y(t)} y2={y(t)} />
          <text x={L - 8} y={y(t) + 3.5} textAnchor="end">{formatMetric(Math.round(t * 100) / 100)}</text>
        </g>
      ))}
      {series.slice(1).map((s) => <polyline key={s.name} className="segment" points={line(s.points)} />)}
      {solid.length > 1 && (
        <polygon className="area" points={`${x(0)},${y(0)} ${line(solid)} ${x(solid.length - 1)},${y(0)}`} />
      )}
      <polyline className="line" points={line(solid)} />
      {open && n > 1 && (
        <line className="partial" x1={x(n - 2)} y1={y(head.points[n - 2]!.value)} x2={x(n - 1)} y2={y(head.points[n - 1]!.value)} />
      )}
      <circle className="end" cx={x(n - 1)} cy={y(head.points[n - 1]!.value)} r="3.5" />
      {head.points.map((p, i) => (i % labelEvery === 0 || i === n - 1) && (
        <text key={p.label} x={x(i)} y={H - 7} textAnchor="middle">{shortDate(p.label)}</text>
      ))}
    </svg>
  );
}

/** A report with no time axis: one number, or one bar per category. */
function Breakdown({ series }: { series: MixpanelSeries[] }) {
  const head = series[0];
  if (!head) return <p className="quiet">No numbers.</p>;
  if (head.points.length === 1 && series.length === 1) {
    return <div className="mp-big"><span>{formatMetric(head.points[0]!.value)}</span><small>{head.name}</small></div>;
  }
  const rows = series.length > 1 ? series.map((s) => ({ label: s.name, value: s.points[s.points.length - 1]?.value ?? 0 })) : head.points;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <ul className="mp-bars">
      {rows.map((r) => (
        <li key={r.label}>
          <span className="mp-bar-label" title={r.label}>{r.label}</span>
          <span className="mp-bar"><span style={{ width: `${(r.value / max) * 100}%` }} /></span>
          <span className="mp-num">{formatMetric(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}

function DataTable({ result }: { result: MixpanelResult }) {
  const head = result.series[0];
  if (!head) return null;
  const extra = result.overTime ? result.series.slice(1, 4) : [];
  const open = result.overTime && lastPeriodOpen(head.points, today());
  const rows = result.overTime ? [...head.points].reverse() : head.points;
  return (
    <div className="mp-table-wrap">
      <table className="mp-table">
        <thead>
          <tr>
            <th>{result.overTime ? 'Period' : 'Value'}</th>
            <th className="n" title={head.name}>{result.series.length > 1 ? 'Total' : 'Value'}</th>
            {extra.map((s) => <th key={s.name} className="n" title={s.name}>{s.name}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => (
            <tr key={p.label}>
              <td>{shortDate(p.label)}{open && i === 0 && <span className="mp-dim"> · so far</span>}</td>
              <td className="n">{formatMetric(p.value)}</td>
              {extra.map((s) => <td key={s.name} className="n">{formatMetric(s.points.find((q) => q.label === p.label)?.value)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Discuss ---------------------------------------------------------------

const SUGGESTIONS = ['Summarize the trend', 'What changed most recently, and why?', 'What should I keep an eye on?'];

async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); } catch { /* nothing to fall back to in a sandboxed window */ }
}

/** `opencode/x` → `x`; `(claude)` → `claude`; `sonnet (claude)` → `claude · sonnet`. */
function modelLabel(model: string): string {
  return parseReviewToolModel(model) ? reviewToolLabel(model) : model.replace(/^opencode\//, '');
}

function Answer({ message, onNote }: { message: DiscussMessage; onNote: (text: string) => void }) {
  const [showQueries, setShowQueries] = useState(false);
  const [copied, setCopied] = useState(false);
  const [noted, setNoted] = useState(false);
  const failed = message.text.startsWith('Could not answer:');
  return (
    <div className={`mp-msg model${failed ? ' failed' : ''}`}>
      <span className="mp-who">
        {failed && <span className="dot fail" />}
        {message.model ? modelLabel(message.model) : 'model'}{message.queries?.length ? ` · ran ${message.queries.length} quer${message.queries.length === 1 ? 'y' : 'ies'}` : ''} · {age(message.at)}
      </span>
      <div className="mp-text">{message.text}</div>
      {showQueries && message.queries?.map((q, i) => (
        <div key={i} className="mp-query">
          <code>{describeMixpanelQuery(q.query)}</code>
          {q.error ? <span className="mp-query-error">{q.error}</span> : (
            <span className="mp-dim">{(q.series ?? []).slice(0, 4).map((s) => `${s.name}: ${formatMetric(s.points[s.points.length - 1]?.value)}`).join(' · ') || 'No rows.'}</span>
          )}
        </div>
      ))}
      {!failed && (
        <span className="mp-msg-actions">
          <button type="button" className="link" onClick={() => { void copyText(message.text); setCopied(true); }}>{copied ? 'Copied' : 'Copy'}</button>
          <button type="button" className="link" disabled={noted} onClick={() => { onNote(message.text); setNoted(true); }}>{noted ? 'Added to notes' : 'Add to report notes'}</button>
          {message.queries?.length ? (
            <button type="button" className="link" onClick={() => setShowQueries((v) => !v)}>{showQueries ? 'Hide the query' : 'Show the query'}</button>
          ) : null}
        </span>
      )}
    </div>
  );
}

/**
 * The composer's model tag: what answers, and the picker to change it. The
 * same picker as the Review button's, so besides opencode's providers it
 * offers the reviewers added in Settings — Claude Code, Codex, your commands.
 * Remembered for Discuss only (`mixpanel.discussModel`).
 */
function DiscussModel({ model, disabled, onPick }: { model: string; disabled: boolean; onPick: (model: string) => void }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<MenuPlace>({ alignRight: false });
  useMenuDismiss(open, () => setOpen(false));
  const own = parseReviewToolModel(model);
  const name = modelLabel(model);
  return (
    <span className="mp-model-pick">
      <button
        type="button" className="mp-model" disabled={disabled || !model} aria-expanded={open}
        aria-label={`Model for Discuss: ${name || 'default'}. Change`}
        title={model ? `Answers come from ${model}. Click to change.` : 'Click to choose the model'}
        onClick={(e) => {
          e.stopPropagation();
          setPlace(menuPlace(e.currentTarget));
          setOpen((v) => !v);
        }}
      >
        <span className="mp-model-name">{name}</span>
        {!own && /free/i.test(model) && <span className="quick-tag">FREE</span>}
        <ChevronIcon size={9} open={open} />
      </button>
      {open && (
        <QuickModelPicker
          reviewers agents label="Discuss" model={model} place={place} className="opens-up"
          onPick={(next) => { onPick(next); setOpen(false); }}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  );
}

function DiscussPanel({
  report, result, onClose, onNotes
}: {
  report: MixpanelReport;
  result?: MixpanelResult;
  onClose: () => void;
  onNotes: (notes: string[]) => void;
}) {
  const [messages, setMessages] = useState<DiscussMessage[]>([]);
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string>();
  const [draft, setDraft] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    setMessages([]);
    setConfirmClear(false);
    void window.kovan.mixpanelThread(report.id).then((t) => {
      if (!live) return;
      setMessages(t.messages);
      setModel(t.model);
      setBusy(t.busy);
    });
    const off = window.kovan.onMixpanelProgress((p) => {
      if (p.reportId !== report.id) return;
      setStep(p.step);
    });
    return () => { live = false; off(); };
  }, [report.id]);

  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [messages.length, busy]);

  const send = useCallback(async (question: string) => {
    const text = question.trim();
    if (!text || busy) return;
    setDraft('');
    setBusy(true);
    setMessages((m) => [...m, { role: 'you', text, at: Date.now() }]);
    try {
      setMessages(await window.kovan.mixpanelAsk(report, text));
    } catch (err) {
      setMessages((m) => [...m, { role: 'model', text: `Could not answer: ${err instanceof Error ? err.message : String(err)}`, at: Date.now() }]);
    } finally {
      setBusy(false);
      setStep(undefined);
    }
  }, [busy, report]);

  const addNote = useCallback((text: string) => {
    void window.kovan.mixpanelNoteAdd(report.id, text).then(onNotes);
  }, [report.id, onNotes]);

  const pickModel = useCallback((next: string) => {
    void window.kovan.mixpanelModelSet(next).then(setModel);
  }, []);

  return (
    <aside className="mp-dock" aria-label="Discuss this report">
      <div className="mp-dock-head">
        <SparklesIcon size={13} />
        <h2>Discuss this report</h2>
        {messages.length > 0 && !busy && (
          confirmClear ? (
            <span className="mp-confirm">
              Clear?
              <button type="button" className="link" onClick={() => { void window.kovan.mixpanelThreadClear(report.id).then(() => setMessages([])); setConfirmClear(false); }}>Clear</button>
              <button type="button" className="link" onClick={() => setConfirmClear(false)}>Cancel</button>
            </span>
          ) : (
            <button type="button" className="icon-button" aria-label="Clear the conversation" title="Clear the conversation" onClick={() => setConfirmClear(true)}>
              <TrashIcon size={13} />
            </button>
          )
        )}
        <button type="button" className="icon-button boxed" aria-label="Close Discuss" title="Close Discuss" onClick={onClose}>
          <CloseIcon size={12} />
        </button>
      </div>
      <div className="mp-context">
        <span className="mp-label">AI sees</span>
        <span className="mp-chip">{result ? `this report · ${result.series[0]?.points.length ?? 0} ${result.overTime ? 'periods' : 'values'}` : 'this report (not loaded)'}</span>
        {report.dashboard && <span className="mp-chip">{report.dashboard.title}</span>}
        <span className="mp-chip">your notes</span>
      </div>
      <div className="mp-msgs">
        {messages.length === 0 && !busy && (
          <p className="mp-empty">
            Ask about this report. The model reads its numbers and may run up to two read-only Mixpanel queries per
            question, for example to split it by a property.
          </p>
        )}
        {messages.map((m, i) => m.role === 'you'
          ? <div key={i} className="mp-msg you">{m.text}</div>
          : <Answer key={i} message={m} onNote={addNote} />)}
        {busy && (
          <div className="mp-msg model">
            <span className="mp-who"><span className="dot running pulse" />{modelLabel(model)}</span>
            <span className="mp-dim">{step ?? 'Thinking'}…</span>
          </div>
        )}
        <div ref={end} />
      </div>
      {!busy && (
        <div className="mp-suggest">
          {SUGGESTIONS.map((s) => <button key={s} type="button" className="mp-chip button" onClick={() => void send(s)}>{s}</button>)}
        </div>
      )}
      {/* Not a <form>: the model picker in its foot holds a form of its own. */}
      <div className="mp-composer">
        <label htmlFor="mp-question" className="sr-only" style={{ display: 'none' }}>Ask about this report</label>
        <textarea
          id="mp-question" rows={2} placeholder="Ask about this report…" value={draft} disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(draft); } }}
        />
        <div className="mp-composer-foot">
          <DiscussModel model={model} disabled={busy} onPick={pickModel} />
          <button type="button" className="quick" disabled={busy || !draft.trim()} onClick={() => void send(draft)}>Ask</button>
        </div>
      </div>
    </aside>
  );
}

// --- The report pane -------------------------------------------------------

function ReportPane({
  report, status, pinned, initial, fetch, onTogglePin, onResult, onRemove
}: {
  report: MixpanelReport;
  status: MixpanelStatus;
  pinned: boolean;
  /** The numbers already kept for it, shown at once. */
  initial?: MixpanelResult;
  /**
   * Whether opening it may ask Mixpanel (main still reuses numbers under 15
   * minutes old): when you picked it in the list, not when you came back to
   * the tab. Without kept numbers it is always asked once.
   */
  fetch: boolean;
  onTogglePin: () => void;
  onResult: (result: MixpanelResult) => void;
  onRemove?: () => void;
}) {
  const [result, setResult] = useState<MixpanelResult | undefined>(initial);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const [discuss, setDiscuss] = useState(() => readLocal(DISCUSS_KEY) === '1');
  const [, tick] = useState(0);

  const load = useCallback(async (force: boolean) => {
    setLoading(true);
    setError(undefined);
    try {
      const r = await window.kovan.mixpanelResult(report.id, report.type, force);
      setResult(r);
      onResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err));
    } finally {
      setLoading(false);
    }
  }, [report.id, report.type, onResult]);

  // Once per pane: the parent keys it by report, so `initial` and `fetch` are
  // read as they were when it opened.
  const [askOnOpen] = useState(() => !initial || fetch);
  useEffect(() => {
    if (askOnOpen) void load(false);
    void window.kovan.mixpanelThread(report.id).then((t) => setNotes(t.notes));
  }, [report.id, load, askOnOpen]);

  // "updated 2m ago" stays true.
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const toggleDiscuss = (on: boolean) => { setDiscuss(on); writeLocal(DISCUSS_KEY, on ? '1' : '0'); };
  const url = status.region && status.projectId ? mixpanelReportUrl(status.region, status.projectId, report) : undefined;
  const h = headline(result);

  return (
    <>
      <div className="mp-report">
        <div className="mp-report-head">
          <div className="mp-places">
            {url && (
              <button type="button" className="detail-place" onClick={() => void window.kovan.openExternal(url)} title={url}>
                <OpenLinkIcon size={12} /> Mixpanel
              </button>
            )}
            {report.dashboard && <span className="mp-chip">{report.dashboard.title}</span>}
          </div>
          <h1 className="mp-title">{report.name}</h1>
          <div className="mp-meta">
            <span>{report.type === 'other' ? 'Report' : report.type[0]!.toUpperCase() + report.type.slice(1)}</span>
            {report.creator && <span>{report.creator}</span>}
            {result && <span className="mono" title={new Date(result.fetchedAt).toLocaleString()}>updated {age(result.fetchedAt)}</span>}
            {result?.from && <span className="mono">{result.from} → {result.to ?? today()}</span>}
            {h.value !== undefined && <span className="mono mp-strong">{formatMetric(h.value)}{h.change !== undefined ? ` · ${formatChange(h.change)}` : ''}</span>}
          </div>
          {report.description && <p className="mp-desc">{report.description}</p>}
          <div className="mp-actions">
            <button type="button" className={`ghost${discuss ? ' on' : ''}`} aria-pressed={discuss} onClick={() => toggleDiscuss(!discuss)}>
              <SparklesIcon size={12} /> Discuss
            </button>
            <span className="action-divider" />
            <button type="button" className="ghost" disabled={loading} onClick={() => void load(true)} title="Ask Mixpanel again (it allows 60 queries an hour)">
              <RefreshIcon size={12} /> {loading ? 'Loading…' : 'Refresh'}
            </button>
            <button type="button" className={`ghost${pinned ? ' on' : ''}`} aria-pressed={pinned} onClick={onTogglePin}>
              <PinIcon size={11} /> {pinned ? 'Pinned' : 'Pin'}
            </button>
            {onRemove && <button type="button" className="link" onClick={onRemove}>Remove from list</button>}
          </div>
        </div>

        {error ? (
          <div className="mp-card mp-error">
            <span className="dot fail" /> <span>{error}</span>
            {/Settings › Connections/.test(error) && <button type="button" className="ghost" onClick={openMixpanelSettings}>Fix in Settings</button>}
            <button type="button" className="ghost" onClick={() => void load(true)}>Try again</button>
          </div>
        ) : !result ? (
          <div className="mp-card mp-loading"><span className="dot running pulse" /> Loading the report from Mixpanel…</div>
        ) : (
          <div className="mp-grid">
            <div className="mp-card">
              <div className="mp-card-head"><b>{result.series[0]?.name ?? report.name}</b>{result.series.length > 1 && <span className="mp-dim">+ {result.series.length - 1} segments</span>}</div>
              {result.overTime ? <LineChart series={result.series} /> : <Breakdown series={result.series} />}
            </div>
            <div className="mp-card">
              <div className="mp-card-head"><b>Data</b><span className="mp-dim">{result.series[0]?.points.length ?? 0} rows</span></div>
              <DataTable result={result} />
            </div>
          </div>
        )}

        {notes.length > 0 && (
          <div className="mp-card mp-notes">
            <div className="mp-card-head"><b>Notes</b><span className="mp-dim">kept on this report, read by Discuss</span></div>
            <ul>
              {notes.map((n, i) => (
                <li key={i}>
                  <span>{n}</span>
                  <button type="button" className="icon-button" aria-label="Remove note" title="Remove note"
                    onClick={() => void window.kovan.mixpanelNoteRemove(report.id, i).then(setNotes)}>
                    <CloseIcon size={10} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {discuss && (
        <>
          <Resizer
            edge="before" cssVar="--discuss-w" storageKey={DISCUSS_WIDTH_KEY}
            min={DISCUSS_MIN} max={discussMax} label="Resize Discuss"
          />
          <DiscussPanel report={report} result={result} onClose={() => toggleDiscuss(false)} onNotes={setNotes} />
        </>
      )}
    </>
  );
}

// --- The tab ---------------------------------------------------------------

function AddReport({ onAdded, onCancel }: { onAdded: (report: MixpanelReport) => void; onCancel: () => void }) {
  const [ref, setRef] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function add() {
    setBusy(true);
    setError(undefined);
    try {
      onAdded(await window.kovan.mixpanelAdd(ref, name));
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="mp-add" onSubmit={(e) => { e.preventDefault(); void add(); }}>
      <input autoFocus aria-label="Report link or number" placeholder="Report link or number" value={ref} onChange={(e) => setRef(e.target.value)} />
      <input aria-label="Name (optional)" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="mp-add-foot">
        <button type="submit" className="primary" disabled={busy || !ref.trim()}>{busy ? 'Checking…' : 'Add report'}</button>
        <button type="button" className="link" onClick={onCancel}>Cancel</button>
      </div>
      {error && <p className="settings-note error">{error}</p>}
    </form>
  );
}

export function MixpanelView() {
  const [status, setStatus] = useState<MixpanelStatus | undefined>(memory.status);
  const [list, setList] = useState<MixpanelReportList | undefined>(memory.list);
  const [listLoading, setListLoading] = useState(false);
  // Undefined until main's kept numbers arrive; a report waits for them so it
  // can show them rather than ask Mixpanel.
  const [cached, setCached] = useState<Record<string, MixpanelResult> | undefined>(memory.cached);
  const [pins, setPins] = useState<number[]>(memory.pins ?? []);
  const [added, setAdded] = useState<number[]>(memory.added ?? []);
  /** Whether the open report was picked in the list since the tab opened. */
  const picked = useRef(false);

  useEffect(() => {
    Object.assign(memory, { status, list, cached, pins, added });
  }, [status, list, cached, pins, added]);
  const [filter, setFilter] = useState('');
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [selectedId, setSelectedId] = useState<number | undefined>(() => {
    const saved = Number(readLocal(SELECTED_KEY));
    return Number.isFinite(saved) && saved > 0 ? saved : undefined;
  });

  const loadList = useCallback(async (force: boolean) => {
    setListLoading(true);
    try {
      setList(await window.kovan.mixpanelReports(force));
      const settings = await window.kovan.settings();
      setAdded(Array.isArray(settings['mixpanel.added']) ? (settings['mixpanel.added'] as { id: number }[]).map((a) => a.id) : []);
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!memory.pins) {
      void window.kovan.settings().then((settings) => {
        const p = settings['mixpanel.pins'];
        setPins(Array.isArray(p) ? p.filter((x): x is number => typeof x === 'number') : []);
      });
    }
    if (!memory.cached) void window.kovan.mixpanelCached().then(setCached);
    // Read from settings and the Keychain, not Mixpanel. The list is asked for
    // only when there is none yet, the last try failed, or the project changed.
    const before = memory.status;
    void window.kovan.mixpanelStatus().then((s) => {
      setStatus(s);
      const moved = before !== undefined && (before.projectId !== s.projectId || before.region !== s.region);
      if (s.connected && !s.problem && (!memory.list || memory.list.error || moved)) void loadList(false);
    });
  }, [loadList]);

  const groups = useMemo(() => groupMixpanelReports(list?.reports ?? [], pins, filter), [list, pins, filter]);
  const selected = list?.reports.find((r) => r.id === selectedId);

  const select = (id: number) => { picked.current = true; setSelectedId(id); writeLocal(SELECTED_KEY, String(id)); };
  const togglePin = (id: number) => {
    const next = pins.includes(id) ? pins.filter((p) => p !== id) : [...pins, id];
    setPins(next);
    void window.kovan.setSetting('mixpanel.pins', next);
  };
  const onResult = useCallback((r: MixpanelResult) => setCached((c) => ({ ...(c ?? {}), [r.reportId]: r })), []);

  const notReady = status && (!status.connected || status.problem);
  // A secret Mixpanel turned down, or a project it doesn't know: nothing in
  // the list can load either, so the pane says what to fix instead of "pick one".
  const refused = list?.errorKind === 'auth' || list?.errorKind === 'notFound' || list?.errorKind === 'access';

  return (
    <>
      <aside className="queue" aria-label="Mixpanel">
        <div className="queue-head">
          <div className="queue-title-row">
            <h1>Mixpanel</h1>
            {status?.projectId && <span className="mp-project" title="Project ID and data region">{status.projectId} · {status.region?.toUpperCase()}</span>}
            {!notReady && (
              <>
                <button type="button" className="icon-button" aria-label="Add a report by link" title="Add a report by link" onClick={() => setAdding((a) => !a)}>
                  <PlusIcon size={13} />
                </button>
                <button type="button" className="icon-button" aria-label="Reload the report list" title="Reload the report list" disabled={listLoading} onClick={() => void loadList(true)}>
                  <RefreshIcon size={13} />
                </button>
              </>
            )}
          </div>
          {!notReady && (
            <div className="search">
              <SearchIcon />
              <label htmlFor="mp-filter" className="sr-only" style={{ display: 'none' }}>Filter reports</label>
              <input id="mp-filter" type="text" placeholder="Filter reports" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
          )}
        </div>
        {adding && (
          <AddReport
            onCancel={() => setAdding(false)}
            onAdded={(r) => { setAdding(false); void loadList(false).then(() => select(r.id)); }}
          />
        )}
        <div className="queue-list">
          {!status ? null : !status.connected ? (
            <p className="quiet">Not connected yet. {status.missing?.length ? `${status.missing.length} setting${status.missing.length === 1 ? '' : 's'} missing.` : ''}</p>
          ) : status.problem ? (
            <p className="quiet">Needs a fix in Settings.</p>
          ) : !list ? (
            <p className="quiet">Loading your reports…</p>
          ) : (
            <>
              {list.error && (
                <div className="mp-list-error">
                  <span className="dot fail" />
                  <span>
                    {list.error}{' '}
                    {list.errorKind === 'auth' || list.errorKind === 'access' || list.errorKind === 'notFound'
                      ? <button type="button" className="link" onClick={openMixpanelSettings}>Fix in Settings</button>
                      : list.errorKind === 'limit' ? null : 'You can still add reports by their link with +.'}
                  </span>
                </div>
              )}
              {groups.length === 0 && <p className="quiet">{filter ? 'No reports match.' : 'No saved reports. Add one by its link with +.'}</p>}
              {groups.map((g) => {
                const open = !folded.has(g.title) || Boolean(filter);
                return (
                  <section key={g.title}>
                    <GroupHead label={g.title} count={g.reports.length} open={open}
                      onToggle={() => setFolded((f) => { const n = new Set(f); if (n.has(g.title)) n.delete(g.title); else n.add(g.title); return n; })} />
                    {open && (
                      <ul className="rows">
                        {g.reports.map((r) => {
                          const res = cached?.[r.id];
                          const hl = headline(res);
                          return (
                            <li key={r.id}>
                              <button type="button" className={r.id === selectedId ? 'row selected' : 'row'} onClick={() => select(r.id)}>
                                <span className="row-top">
                                  <span className="row-title" title={r.name}>{r.name}</span>
                                  {pins.includes(r.id) && <span className="mp-pin" title="Pinned"><PinIcon size={10} /></span>}
                                  <span className="mp-value">{hl.value !== undefined ? formatMetric(hl.value) : ''}</span>
                                </span>
                                {res && res.overTime ? (
                                  <span className="row-state">
                                    <Spark points={res.series[0]?.points.slice(-14) ?? []} />
                                    {hl.change !== undefined && <span className={hl.change >= 0 ? 'mp-up' : 'mp-down'}>{formatChange(hl.change)}</span>}
                                    <span className="spacer" />
                                    <span className="row-age">{age(res.fetchedAt)}</span>
                                  </span>
                                ) : null}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </section>
                );
              })}
            </>
          )}
        </div>
      </aside>
      <Resizer />
      <main className="pane mp-pane">
        {!status ? null : notReady ? (
          <MixpanelSetup status={status} />
        ) : refused && !selected ? (
          <MixpanelSetup status={status} refused={list?.error} />
        ) : selected && !cached ? null : selected ? (
          <ReportPane
            key={selected.id}
            report={selected}
            status={status}
            pinned={pins.includes(selected.id)}
            {...(cached?.[selected.id] ? { initial: cached[selected.id] } : {})}
            fetch={picked.current}
            onTogglePin={() => togglePin(selected.id)}
            onResult={onResult}
            {...(added.includes(selected.id) ? {
              onRemove: () => void window.kovan.mixpanelRemoveAdded(selected.id).then(() => loadList(false))
            } : {})}
          />
        ) : (
          <p className="quiet mp-pick">{list && list.reports.length ? 'Pick a report on the left.' : ''}</p>
        )}
      </main>
    </>
  );
}

