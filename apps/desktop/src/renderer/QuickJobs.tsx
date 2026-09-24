/**
 * The Sessions tab's "Quick model" list: every recent Summarize and Condense,
 * with a detail pane saying what it read, what it was told, what came back,
 * what it cost, and which tool calls it tried and had refused.
 *
 * Not terminal sessions — a quick job has no pty, only a record kept by
 * `main/quick.ts` — so the rows sit under their own heading and open their
 * own pane rather than joining the split view.
 */

import { useEffect, useState } from 'react';
import { QUICK_KIND_LABEL, formatAge, type QuickJob } from '@baton/core';
import { Prose } from './Prose';
import { ChevronIcon, CloseIcon, OpenLinkIcon } from './icons';
import { findSubject, type Selection } from './sessionSubject';
import type { Snapshot } from './types';

export function useQuickJobs(): QuickJob[] {
  const [jobs, setJobs] = useState<QuickJob[]>([]);
  useEffect(() => {
    void window.baton.quickJobs().then(setJobs);
    return window.baton.onQuickJobs(setJobs);
  }, []);
  return jobs;
}

/** Ticks once a second while `running`, so a live job's clock moves. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

/** "just now" already says when; only a real age wants "ago" after it. */
function startedAgo(startedAt: number): string {
  const age = formatAge(new Date(startedAt).toISOString()) ?? '';
  return /now/.test(age) ? age : `${age} ago`;
}

// Running is amber and pulses; done is the quiet green of finished work.
// Both used to be green (live and pass), and a running job could not be told
// from a finished one at a glance.
const STATUS_DOT: Record<QuickJob['status'], string> = {
  running: 'dot running pulse', done: 'dot pass', failed: 'dot fail', cancelled: 'dot'
};

/** The word at the end of the row: the state, or for finished work its age. */
function rowState(job: QuickJob, now: number): string {
  switch (job.status) {
    case 'running': return `running ${seconds(now - job.startedAt)}`;
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'done': return formatAge(new Date(job.finishedAt ?? job.startedAt).toISOString()) ?? '';
  }
}

function statusText(job: QuickJob, now: number): string {
  switch (job.status) {
    case 'running': return `running · ${seconds(now - job.startedAt)}`;
    case 'done': return `done · ${seconds((job.finishedAt ?? now) - job.startedAt)}`;
    case 'cancelled': return 'cancelled';
    case 'failed': return 'failed';
  }
}

function StopIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

/**
 * A job's row: open its ticket or pull request, cancel it while it runs, or
 * close it off the list. A div, not a button, for the same reason as a
 * session's row — the icons inside are buttons of their own.
 */
export function QuickJobRow({
  job, selected, onSelect, snapshot, onOpenSubject
}: {
  job: QuickJob;
  selected: boolean;
  onSelect: () => void;
  snapshot: Snapshot;
  onOpenSubject: (match: Selection) => void;
}) {
  const now = useNow(job.status === 'running');
  const match = findSubject(job.subject, snapshot);
  const running = job.status === 'running';
  return (
    <li>
      <div
        className={['row one-line quick-job', running ? 'running' : 'finished', selected ? 'selected' : ''].join(' ').trim()}
        role="button"
        tabIndex={0}
        title={statusText(job, now)}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
          e.preventDefault();
          onSelect();
        }}
      >
        {/* One line, the same as a session row. The state is a dot and a
            word: amber and counting while it runs, the age once done. The
            actions take the word's place on hover. */}
        <span className="row-top">
          <span className={STATUS_DOT[job.status]} />
          <span className="row-title">{QUICK_KIND_LABEL[job.kind]} · {job.subject}</span>
          <span className="quick-job-actions">
            {match && (
              <button
                type="button" className="icon-button open-link"
                aria-label={`Open ${job.subject}`} title={`Open ${job.subject}`}
                onClick={(e) => { e.stopPropagation(); onOpenSubject(match); }}
              >
                <OpenLinkIcon />
              </button>
            )}
            {running && (
              <button
                type="button" className="icon-button"
                aria-label="Cancel" title="Cancel"
                onClick={(e) => { e.stopPropagation(); void window.baton.quickCancel(job.kind, job.subject); }}
              >
                <StopIcon />
              </button>
            )}
            <button
              type="button" className="icon-button"
              aria-label={running ? 'Cancel and close' : 'Close'} title={running ? 'Cancel and close' : 'Close'}
              onClick={(e) => { e.stopPropagation(); void window.baton.quickJobRemove(job.id); }}
            >
              <CloseIcon size={10} />
            </button>
          </span>
          <span className={`quick-job-state ${job.status}`}>{rowState(job, now)}</span>
        </span>
      </div>
    </li>
  );
}

/** A long block of text, shut by default: most of the time the answer is what you came for. */
function Fold({ title, text }: { title: string; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="quick-job-fold">
      <button type="button" className="quick-job-fold-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <ChevronIcon size={11} open={open} />
        <h3>{title}</h3>
        <span className="quick-card-meta">{text.length.toLocaleString()} characters</span>
      </button>
      {open && <pre className="quick-job-pre">{text}</pre>}
    </section>
  );
}

export function QuickJobView({
  job, snapshot, onOpenSubject
}: {
  job: QuickJob;
  snapshot: Snapshot;
  onOpenSubject: (match: Selection) => void;
}) {
  const now = useNow(job.status === 'running');
  const match = findSubject(job.subject, snapshot);
  const cancel = () => void window.baton.quickCancel(job.kind, job.subject);

  return (
    <div className="detail-shell">
      <div className="detail-scroll">
        <div className="detail quick-job">
          <header className="detail-head">
            <div className="detail-pill-row">
              <span className={`status-pill ${job.status === 'done' ? 'pass' : job.status === 'failed' ? 'fail' : job.status === 'running' ? 'running' : ''}`}>
                <span className={STATUS_DOT[job.status]} />
                {job.status}
              </span>
              <span className="quick-tag">quick model</span>
            </div>
            <h2 className="quick-job-title">
              {QUICK_KIND_LABEL[job.kind]} · {job.subject}
              {match && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Open ${job.subject}`}
                  title={`Open ${job.subject}`}
                  onClick={() => onOpenSubject(match)}
                >
                  <OpenLinkIcon />
                </button>
              )}
            </h2>
            <div className="detail-meta">
              <span className="mono">{job.model}</span>
              <span>started {startedAgo(job.startedAt)}</span>
              <span>{seconds((job.finishedAt ?? now) - job.startedAt)}{job.status === 'running' ? ' so far' : ''}</span>
            </div>
            <div className="detail-actions">
              {job.status === 'running' && <button type="button" className="ghost" onClick={cancel}>Cancel</button>}
              {match && (
                <button type="button" className="ghost" onClick={() => onOpenSubject(match)}>Open {job.subject}</button>
              )}
              <button type="button" className="ghost" onClick={() => void window.baton.quickJobRemove(job.id)}>
                {job.status === 'running' ? 'Cancel and close' : 'Close'}
              </button>
            </div>
          </header>

          <dl className="quick-job-facts">
            <dt>Tokens</dt>
            <dd>
              {job.tokens
                ? `${job.tokens.input.toLocaleString()} in · ${job.tokens.output.toLocaleString()} out · ${job.tokens.reasoning.toLocaleString()} reasoning`
                : job.status === 'running' ? 'counted when it finishes' : 'not reported'}
              {job.tokens && <span className="quick-card-meta"> · free, not billed</span>}
            </dd>
            <dt>Tool calls</dt>
            <dd>
              {job.refused === undefined
                ? (job.status === 'running' ? 'counted when it finishes' : 'not reported')
                : job.refused.length === 0
                  ? 'none attempted'
                  : (
                    <>
                      {job.refused.length} attempted, all refused
                      <ul className="quick-job-refused">
                        {job.refused.map((call, i) => <li key={i} className="mono">{call}</li>)}
                      </ul>
                    </>
                  )}
            </dd>
          </dl>

          {job.error && job.status !== 'cancelled' && (
            <section>
              <h3>Error</h3>
              <p className="error">{job.error}</p>
            </section>
          )}

          {job.answer && (
            <section>
              <h3>Answer</h3>
              <div className="quick-card-body"><Prose text={job.answer} /></div>
            </section>
          )}

          {job.status === 'running' && !job.answer && (
            <section>
              <h3>Answer</h3>
              <div className="quick-skeleton" style={{ width: '80%' }} />
              <div className="quick-skeleton" style={{ width: '60%' }} />
            </section>
          )}

          {job.input && <Fold title="What it read" text={job.input} />}
          {job.instruction && <Fold title="Instruction" text={job.instruction} />}
        </div>
      </div>
    </div>
  );
}
