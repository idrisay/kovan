/**
 * The quick model's button and card: "Summarize" on a pull request,
 * "Condense" on a ticket.
 *
 * A third button weight, on purpose. Solid clay writes code, outline clay
 * reads and judges — both are agent runs. This one is neither: a free, slower
 * model that only turns text Baton already has into shorter text, so it gets
 * its own dashed blue look and a "free" tag rather than one more clay pill
 * that could be mistaken for "Unblock in an agent".
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  NV_REVIEW_DEFAULT_MODEL, REVIEW_EVENT_LABEL, describeChange, formatAge, priceFor, reviewModelName,
  type PriceRule, type QuickBasis, type QuickKind, type QuickResult, type ReviewEvent, type ReviewVerdict
} from '@baton/core';
import { Prose } from './Prose';
import { CloseIcon } from './icons';
import { useUsage } from './Usage';
import type { QuickState } from './types';

export function useQuick(kind: QuickKind, subject: string) {
  const [state, setState] = useState<QuickState>({});

  // A small JSON file read in main — not a model call. Nothing runs until
  // somebody clicks.
  useEffect(() => {
    let live = true;
    setState({});
    void window.baton.quickState(kind, subject).then((s) => live && setState(s));
    const off = window.baton.onQuick((k, s, next) => {
      if (k === kind && s === subject) setState(next);
    });
    return () => {
      live = false;
      off();
    };
  }, [kind, subject]);

  return {
    state,
    run: useCallback(() => void window.baton.quickRun(kind, subject), [kind, subject]),
    cancel: useCallback(() => void window.baton.quickCancel(kind, subject), [kind, subject]),
    dismiss: useCallback(() => void window.baton.quickDismiss(kind, subject), [kind, subject])
  };
}

/** Seconds since `since`, ticking once a second — only while something runs. */
function useElapsed(since?: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return since ? Math.max(0, Math.round((now - since) / 1000)) : 0;
}

function LinesIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4 6h16M4 12h10M4 18h6" />
    </svg>
  );
}

const MODEL_CHANGED = 'baton:quick-model-changed';

/** The model a quick action runs on, kept in step across every button showing it. */
function useQuickModel(kind: QuickKind): [string, (model: string) => Promise<void>] {
  const [model, setModel] = useState('');
  useEffect(() => {
    let live = true;
    const load = () => void window.baton.quickModel(kind).then((m) => live && setModel(m));
    load();
    const onChange = (event: Event) => { if ((event as CustomEvent<QuickKind>).detail === kind) load(); };
    window.addEventListener(MODEL_CHANGED, onChange);
    return () => { live = false; window.removeEventListener(MODEL_CHANGED, onChange); };
  }, [kind]);
  const set = useCallback(async (next: string) => {
    await window.baton.quickModelSet(kind, next);
    window.dispatchEvent(new CustomEvent(MODEL_CHANGED, { detail: kind }));
  }, [kind]);
  return [model, set];
}

/** `opencode/muse-spark-1.3-contributor-free` → `muse-spark-1.3`; nv-review's → `Kimi K3`. */
export function shortModelName(kind: QuickKind, model: string): string {
  if (kind === 'pull-review') return reviewModelName(model);
  return (model.split('/').pop() ?? model).replace(/-(contributor-)?free$/, '');
}

/** FREE, the list price per million tokens, or nothing when no price row knows it. */
function costLabel(kind: QuickKind, model: string, prices: PriceRule[]): { text: string; free: boolean } | undefined {
  // nv-review goes through NVIDIA's free API whatever the model.
  if (kind === 'pull-review' || /free/i.test(model)) return { text: 'FREE', free: true };
  const price = priceFor(model, prices);
  if (!price) return undefined;
  if (price.input === 0 && price.output === 0) return { text: 'FREE', free: true };
  return { text: `$${price.input}/$${price.output}`, free: false };
}

export function QuickButton({
  kind,
  label,
  runningLabel,
  state,
  onRun,
  tooltip = 'Runs a quick model on this text. It reads only; it never changes code.'
}: {
  kind: QuickKind;
  label: string;
  runningLabel: string;
  state: QuickState;
  onRun: () => void;
  tooltip?: string;
}) {
  const elapsed = useElapsed(state.running);
  const [model, setModel] = useQuickModel(kind);
  const { prices } = useUsage();
  const [picking, setPicking] = useState(false);
  const cost = model ? costLabel(kind, model, prices) : undefined;

  useEffect(() => {
    if (!picking) return undefined;
    const close = () => setPicking(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [picking]);

  // One pill, two controls: the label runs it, the tag picks the model. Two
  // buttons side by side rather than one inside the other, which HTML forbids.
  return (
    <span className={state.running ? 'quick-split running' : 'quick-split'}>
      <button type="button" className="quick quick-run" disabled={Boolean(state.running)} onClick={onRun} title={tooltip}>
        <LinesIcon />
        {state.running ? `${runningLabel}… ${elapsed}s` : label}
      </button>
      <button
        type="button" className="quick quick-model"
        aria-label={`Model for ${label}: ${model || 'default'}. Change`} aria-expanded={picking}
        title={model ? `Runs on ${model}. Click to change.` : 'Click to choose the model'}
        onClick={(e) => { e.stopPropagation(); setPicking((v) => !v); }}
      >
        {model && <span className="quick-model-name">{shortModelName(kind, model)}</span>}
        {cost && <span className={cost.free ? 'quick-tag' : 'quick-tag paid'}>{cost.text}</span>}
      </button>
      {picking && (
        <QuickModelPicker
          kind={kind} label={label} model={model}
          onPick={(next) => { void setModel(next); setPicking(false); }}
        />
      )}
    </span>
  );
}

/**
 * The tag's popover: a provider, then one of its models, or any name typed
 * in. For nv-review the provider is NVIDIA through your `nv-review` function,
 * and the model is whatever `NV_MODEL` it should be told.
 */
function QuickModelPicker({ kind, label, model, onPick }: {
  kind: QuickKind; label: string; model: string; onPick: (model: string) => void;
}) {
  const review = kind === 'pull-review';
  const [available, setAvailable] = useState<string[]>();
  const [provider, setProvider] = useState(() => (review ? 'nvidia' : model.split('/')[0] ?? ''));
  const [typed, setTyped] = useState(model);

  useEffect(() => {
    if (review) return;
    void window.baton.quickModelsAvailable().then(setAvailable);
  }, [review]);

  const providers = [...new Set((available ?? []).map((m) => m.split('/')[0]!))].sort();
  const models = (available ?? []).filter((m) => m.startsWith(`${provider}/`));
  const suggestions = review ? [NV_REVIEW_DEFAULT_MODEL] : models;

  return (
    <div className="menu quick-model-menu" role="dialog" aria-label={`${label} model`} onClick={(e) => e.stopPropagation()}>
      <div className="menu-head">{label} with</div>
      <label className="quick-model-field">
        <span>Provider</span>
        {review ? (
          <select value="nvidia" disabled><option value="nvidia">NVIDIA · nv-review</option></select>
        ) : (
          <select value={provider} onChange={(e) => setProvider(e.target.value)} disabled={!available}>
            {!available && <option value={provider}>Loading…</option>}
            {available && !providers.includes(provider) && <option value={provider}>{provider || 'Choose…'}</option>}
            {providers.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        )}
      </label>
      <div className="quick-model-list" role="listbox">
        {suggestions.map((m) => (
          <button key={m} type="button" role="option" aria-selected={m === model} className={m === model ? 'active' : ''} onClick={() => onPick(m)}>
            <span className="quick-model-id">{m.slice(m.indexOf('/') + 1)}</span>
            {/free/i.test(m) && <span className="quick-tag">FREE</span>}
          </button>
        ))}
        {!review && available && models.length === 0 && <p className="menu-empty">No models listed for this provider.</p>}
      </div>
      <div className="menu-rule" />
      <form
        className="quick-model-other"
        onSubmit={(e) => { e.preventDefault(); if (typed.trim()) onPick(typed.trim()); }}
      >
        <input
          type="text" value={typed} onChange={(e) => setTyped(e.target.value)}
          placeholder={review ? 'moonshotai/kimi-k3' : 'provider/model'} aria-label="Another model"
        />
        <button type="submit" className="ghost">Use</button>
      </form>
      <p className="menu-empty">Remembered for {label.split(' ')[0]}. Settings → General has the default.</p>
    </div>
  );
}

export function QuickCard({
  kind,
  title,
  subtitle,
  runningNote,
  tag = 'quick model',
  state,
  basisNow,
  footer,
  badge,
  children,
  onRun,
  onCancel,
  onDismiss
}: {
  kind: QuickKind;
  title: string;
  subtitle?: string;
  /** What to say while it runs, when "the free model is slow" undersells it. */
  runningNote?: string;
  tag?: string;
  state: QuickState;
  /** What is on screen now, to say whether the saved result is out of date. */
  basisNow?: QuickBasis;
  footer: string;
  /** Sits after the tag in the head — a review's verdict. */
  badge?: ReactNode;
  /** Below the text — a review's submit buttons. Given whether the result is out of date. */
  children?: (stale: boolean) => ReactNode;
  onRun: () => void;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const { result, running, error } = state;
  if (!result && !running && !error) return null;

  if (running) {
    return (
      <section className="quick-card">
        <div className="quick-card-head">
          <span className="quick-card-title">{title}</span>
          <span className="quick-card-meta">{runningNote ?? 'the free model is slow; you can leave this pane'}</span>
          <span className="spacer" />
          <button type="button" className="link" onClick={onCancel}>Cancel</button>
        </div>
        <div className="quick-skeleton" style={{ width: '88%' }} />
        <div className="quick-skeleton" style={{ width: '64%' }} />
      </section>
    );
  }

  if (error && !result) {
    return (
      <section className="quick-card failed">
        <div className="quick-card-head">
          <span className="quick-card-title">{title}</span>
          <span className="spacer" />
          <button type="button" className="icon-button" aria-label="Dismiss" onClick={onDismiss}>
            <CloseIcon />
          </button>
        </div>
        <p className="error">{error}</p>
        <div className="quick-card-links">
          <button type="button" className="link" onClick={onRun}>Try again</button>
        </div>
      </section>
    );
  }

  const change = result && basisNow ? describeChange(kind, result.basis, basisNow) : undefined;
  return (
    <section className={change ? 'quick-card stale' : 'quick-card'}>
      <div className="quick-card-head">
        <span className="quick-card-title">{title}</span>
        {subtitle && <span className="quick-card-meta">{subtitle}</span>}
        <span className="quick-tag">{tag}</span>
        {badge}
        {change && <span className="quick-stale">{change}</span>}
        <span className="spacer" />
        <span className="quick-card-meta">
          {result!.model.replace(/^opencode\//, '')} · {formatAge(result!.createdAt)}
        </span>
        <button type="button" className="link" onClick={onRun}>Refresh</button>
        <button type="button" className="icon-button" aria-label="Dismiss" onClick={onDismiss}>
          <CloseIcon />
        </button>
      </div>
      {error && <p className="error">Refresh failed: {error}</p>}
      <div className="quick-card-body">
        <Prose text={result!.text} />
      </div>
      {children?.(Boolean(change))}
      <div className="quick-card-foot">{footer}</div>
    </section>
  );
}

// --- A code review's decision -----------------------------------------------------------

const VERDICT_EVENT: Record<ReviewVerdict, ReviewEvent> = { approve: 'APPROVE', request_changes: 'REQUEST_CHANGES' };

export function VerdictBadge({ verdict }: { verdict?: ReviewVerdict }) {
  if (!verdict) return null;
  return (
    <span className={verdict === 'approve' ? 'review-verdict approve' : 'review-verdict changes'}>
      Recommends: {verdict === 'approve' ? 'approve' : 'request changes'}
    </span>
  );
}

/**
 * Submit the review to GitHub as approve / request changes / comment. The
 * model recommends; the three buttons are always there and nothing is posted
 * without the inline confirmation — it goes out under the user's own name.
 */
export function ReviewDecision({
  subject, result, stale, onRefresh
}: {
  subject: string;
  result: QuickResult;
  stale: boolean;
  onRefresh: () => void;
}) {
  const [confirming, setConfirming] = useState<ReviewEvent>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const recommended = result.verdict ? VERDICT_EVENT[result.verdict] : undefined;

  useEffect(() => {
    setConfirming(undefined);
    setError(undefined);
  }, [result.createdAt]);

  if (result.submitted) {
    const { event, at, url } = result.submitted;
    return (
      <div className="review-decision posted">
        <span className={event === 'APPROVE' ? 'review-verdict approve' : event === 'REQUEST_CHANGES' ? 'review-verdict changes' : 'review-verdict'}>
          Posted as {REVIEW_EVENT_LABEL[event].toLowerCase()}
        </span>
        <span className="quick-card-meta">{formatAge(at)}</span>
        {url && <button type="button" className="link" onClick={() => void window.baton.openExternal(url)}>View on GitHub</button>}
      </div>
    );
  }

  if (stale) {
    return (
      <div className="review-decision">
        <span className="quick-card-meta">New changes were pushed since this review ran. Refresh it before submitting to GitHub.</span>
        <button type="button" className="link" onClick={onRefresh}>Refresh review</button>
      </div>
    );
  }

  const post = async () => {
    if (!confirming) return;
    setBusy(true);
    setError(undefined);
    const outcome = await window.baton.reviewSubmit(subject, confirming)
      .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    setBusy(false);
    if (outcome.ok) setConfirming(undefined);
    else setError(outcome.error ?? 'GitHub did not accept the review.');
  };

  const order: ReviewEvent[] = ['REQUEST_CHANGES', 'APPROVE', 'COMMENT'];
  return (
    <div className="review-decision">
      <div className="review-decision-row">
        <span className="quick-card-meta">Submit this review to GitHub as:</span>
        {order.map((event) => (
          <button
            key={event}
            type="button"
            className={[
              'review-event',
              event === 'APPROVE' ? 'approve' : event === 'REQUEST_CHANGES' ? 'changes' : '',
              event === recommended ? 'recommended' : '',
              event === confirming ? 'on' : ''
            ].join(' ').trim()}
            disabled={busy}
            onClick={() => setConfirming(event)}
            title={event === recommended ? 'What the review recommends' : undefined}
          >
            {event === 'COMMENT' ? 'Comment only' : REVIEW_EVENT_LABEL[event]}
          </button>
        ))}
      </div>
      {confirming && (
        <div className={confirming === 'REQUEST_CHANGES' ? 'review-confirm changes' : 'review-confirm'}>
          <span>
            Post this review on <span className="mono">{subject}</span> as <b>{REVIEW_EVENT_LABEL[confirming].toLowerCase()}</b>?
            {' '}GitHub shows it under your name. The body is the review above, with a note saying {reviewModelName(result.model)} wrote it.
          </span>
          <div className="review-decision-row">
            <button type="button" className="review-event on" disabled={busy} onClick={() => void post()}>
              {busy ? 'Posting…' : 'Post review'}
            </button>
            <button type="button" className="link" disabled={busy} onClick={() => setConfirming(undefined)}>Cancel</button>
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
