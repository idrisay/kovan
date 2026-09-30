/**
 * The Sessions tab's "Running agents": every Claude Code, Codex and opencode
 * process on this Mac — in Kovan or in any other terminal — with how long it
 * has been idle, what it started, and a Stop that always asks first.
 *
 * The scanning and the signals are `main/running.ts`; this only shows the
 * report and asks it to stop things.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  QUICK_KIND_LABEL,
  formatIdle,
  formatMemory,
  stoppable,
  type AgentGroup,
  type AgentsReport,
  type RunningAgent
} from '@kovan/core';
import { useQuickJobs } from './QuickJobs';
import { SessionUsageChip } from './Usage';
import { ChevronIcon } from './icons';
import { findSubject, type Selection } from './sessionSubject';
import type { Snapshot } from './types';

// --- One shared store -----------------------------------------------------------------

let report: AgentsReport = { at: 0, idleMs: 3_600_000, agents: [] };
const listeners = new Set<() => void>();
let started = false;

function publish(next: AgentsReport): void {
  report = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!started) {
    started = true;
    void window.kovan.runningAgents().then(publish);
    window.kovan.onRunningAgents(publish);
  }
  return () => listeners.delete(listener);
}

export function useRunningAgents(): AgentsReport {
  return useSyncExternalStore(subscribe, () => report);
}

/** Idle agents that Stop is offered for — what the rail's amber pip counts. */
export function idleAgents(r: AgentsReport): RunningAgent[] {
  return r.agents.filter((a) => a.state === 'idle' && stoppable(a));
}

// --- Sidebar row ----------------------------------------------------------------------

export function RunningAgentsRow({ selected, onSelect }: { selected: boolean; onSelect: () => void }) {
  const r = useRunningAgents();
  const mine = r.agents.filter(stoppable);
  const idle = idleAgents(r).length;
  const memory = mine.reduce((sum, a) => sum + a.memory, 0);
  return (
    <ul className="rows">
      <li>
        <button type="button" className={selected ? 'row selected' : 'row'} onClick={onSelect}>
          <span className="row-top"><span className="row-title">Running agents</span></span>
          <span className="row-state">
            <span className="state">
              <span className={idle > 0 ? 'dot running' : mine.length > 0 ? 'dot pass' : 'dot'} />
              {mine.length === 0 ? 'none running' : `${mine.length} running${idle > 0 ? ` · ${idle} idle` : ''}`}
            </span>
            <span className="spacer" />
            {memory > 0 && <span className="agents-chip">{formatMemory(memory)}</span>}
          </span>
        </button>
      </li>
    </ul>
  );
}

// --- The pane -------------------------------------------------------------------------

const GROUPS: { id: AgentGroup; label: string }[] = [
  { id: 'kovan', label: 'In Kovan' },
  { id: 'terminal', label: 'Other terminals' },
  { id: 'background', label: 'Background, no terminal' }
];

type Progress = { phase: 'stopping' } | { phase: 'left'; left: number } | { phase: 'failed' };

export function RunningAgentsPane({
  snapshot, onOpenSubject, onOpenSession
}: {
  snapshot: Snapshot;
  onOpenSubject: (match: Selection) => void;
  onOpenSession: (id: string) => void;
}) {
  const r = useRunningAgents();
  const jobs = useQuickJobs();
  const [confirm, setConfirm] = useState<string[]>();
  const [children, setChildren] = useState(true);
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const [helpersOpen, setHelpersOpen] = useState(false);

  // Fast scans, with ports, only while this pane is on screen.
  useEffect(() => {
    void window.kovan.runningAgentsWatch(true).then(publish);
    return () => void window.kovan.runningAgentsWatch(false);
  }, []);

  const idle = idleAgents(r);
  const running = jobs.filter((j) => j.status === 'running');
  const helpers = r.agents.filter((a) => a.group === 'helper');
  const byKey = useMemo(() => new Map(r.agents.map((a) => [a.key, a])), [r.agents]);
  const confirming = (confirm ?? []).map((k) => byKey.get(k)).filter((a): a is RunningAgent => a !== undefined);

  const stop = async (keys: string[]) => {
    setConfirm(undefined);
    setProgress((p) => ({ ...p, ...Object.fromEntries(keys.map((k) => [k, { phase: 'stopping' } as Progress])) }));
    const outcomes = await window.kovan.runningAgentsStop(keys, children);
    setProgress((p) => {
      const next = { ...p };
      for (const o of outcomes) {
        if (o.left > 0) next[o.key] = { phase: 'left', left: o.left };
        else if (!o.stopped) next[o.key] = { phase: 'failed' };
        else delete next[o.key];
      }
      return next;
    });
  };

  const force = async (key: string) => {
    setProgress((p) => ({ ...p, [key]: { phase: 'stopping' } }));
    const o = await window.kovan.runningAgentsForce(key);
    setProgress((p) => {
      const next = { ...p };
      if (o.left > 0) next[key] = { phase: 'left', left: o.left };
      else delete next[key];
      return next;
    });
  };

  const idleMemory = idle.reduce((sum, a) => sum + a.memory, 0);

  return (
    <div className="detail-shell">
      <div className="detail-scroll">
        <div className="detail agents">
          <header className="detail-head">
            <div className="agents-head">
              <h2 className="quick-job-title">Running agents</h2>
              <span className="spacer" />
              {idle.length > 0 && !confirm && (
                <button type="button" className="agents-stop" onClick={() => setConfirm(idle.map((a) => a.key))}>
                  Stop {idle.length} idle…
                </button>
              )}
            </div>
            <div className="detail-meta">
              <span>
                Claude Code, Codex and opencode on this Mac, in Kovan and in any other terminal.
                Idle means nothing for over {formatIdle(r.idleMs)}. Change that in Settings.
              </span>
            </div>
          </header>

          {confirming.length > 0 && (
            <StopConfirm
              agents={confirming}
              withChildren={children}
              onChildren={setChildren}
              onCancel={() => setConfirm(undefined)}
              onStop={() => void stop(confirming.map((a) => a.key))}
            />
          )}

          {idle.length > 0 && !confirm && (
            <p className="agents-warn">
              {idle.length === 1 ? '1 agent has' : `${idle.length} agents have`} done nothing for over {formatIdle(r.idleMs)},
              holding {formatMemory(idleMemory)}.
            </p>
          )}

          {r.at === 0 ? (
            <p className="quiet">Looking…</p>
          ) : r.agents.filter(stoppable).length === 0 && running.length === 0 ? (
            <p className="quiet">No agents running.</p>
          ) : null}

          {GROUPS.map(({ id, label }) => {
            const list = r.agents.filter((a) => a.group === id);
            if (list.length === 0) return null;
            return (
              <section key={id} className="agents-group">
                <h3>{label} <span className="agents-count">{list.length}</span></h3>
                <ul className="agents-list">
                  {list.map((a) => (
                    <AgentRow
                      key={a.key}
                      agent={a}
                      now={r.at}
                      progress={progress[a.key]}
                      snapshot={snapshot}
                      onOpenSubject={onOpenSubject}
                      onOpenSession={onOpenSession}
                      onStop={() => setConfirm([a.key])}
                      onForce={() => void force(a.key)}
                    />
                  ))}
                </ul>
              </section>
            );
          })}

          {running.length > 0 && (
            <section className="agents-group">
              <h3>Quick model <span className="agents-count">{running.length}</span></h3>
              <ul className="agents-list">
                {running.map((job) => {
                  const match = findSubject(job.subject, snapshot);
                  return (
                    <li key={job.id} className="agent">
                      <span className="agent-state working">running {formatIdle(Date.now() - job.startedAt)}</span>
                      <span className="agent-title">{QUICK_KIND_LABEL[job.kind]} · {job.subject}</span>
                      <span className="agent-actions">
                        {match && <button type="button" className="ghost" onClick={() => onOpenSubject(match)}>Open</button>}
                        <button type="button" className="agents-stop" onClick={() => void window.kovan.quickCancel(job.kind, job.subject)}>
                          Cancel
                        </button>
                      </span>
                      <span className="agent-meta">{job.model}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {helpers.length > 0 && (
            <section className="agents-group">
              <button type="button" className="agents-fold" aria-expanded={helpersOpen} onClick={() => setHelpersOpen((v) => !v)}>
                <ChevronIcon open={helpersOpen} />
                <h3>Helpers, managed by other apps <span className="agents-count">{helpers.length}</span></h3>
              </button>
              {helpersOpen && (
                <>
                  <p className="quick-card-meta">
                    Started and restarted by the app named on each, such as an editor extension or the Chrome bridge.
                    Stopping one only breaks that app until it starts it again, so there is no Stop here.
                  </p>
                  <ul className="agents-list">
                    {helpers.map((a) => (
                      <AgentRow key={a.key} agent={a} now={r.at} snapshot={snapshot} onOpenSubject={onOpenSubject} onOpenSession={onOpenSession} />
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function stateText(agent: RunningAgent, now: number): string {
  if (agent.state === 'working') return 'working';
  const quiet = formatIdle(now - (agent.lastActivity ?? agent.startedAt));
  return `${agent.state} ${quiet}`;
}

function AgentRow({
  agent, now, progress, snapshot, onOpenSubject, onOpenSession, onStop, onForce
}: {
  agent: RunningAgent;
  now: number;
  progress?: Progress;
  snapshot: Snapshot;
  onOpenSubject: (match: Selection) => void;
  onOpenSession: (id: string) => void;
  onStop?: () => void;
  onForce?: () => void;
}) {
  const match = agent.subject ? findSubject(agent.subject, snapshot) : undefined;
  const more = agent.childCount - agent.children.length - agent.ports.length;
  return (
    <li className="agent" title={agent.command}>
      <span className={`agent-state ${agent.state}`}>{stateText(agent, now)}</span>
      <span className="agent-title">{agent.title}</span>
      <span className="agent-actions">
        {agent.sessionId && (
          <button type="button" className="ghost" onClick={() => onOpenSession(agent.sessionId!)}>Open</button>
        )}
        {!agent.sessionId && match && (
          <button type="button" className="ghost" onClick={() => onOpenSubject(match)}>Open</button>
        )}
        {progress?.phase === 'stopping' ? (
          <span className="quick-card-meta">Stopping…</span>
        ) : progress?.phase === 'left' ? (
          <>
            <span className="agent-error">{progress.left === 1 ? '1 process didn\'t stop' : `${progress.left} processes didn't stop`}</span>
            <button type="button" className="agents-stop" onClick={onForce}>Force stop</button>
          </>
        ) : progress?.phase === 'failed' ? (
          <span className="agent-error">Couldn't stop it</span>
        ) : onStop && stoppable(agent) ? (
          <button type="button" className="agents-stop" onClick={onStop}>Stop</button>
        ) : null}
      </span>
      <span className="agent-meta">
        <span>{agent.kind}</span>
        {agent.where && <span className="agent-where">{agent.where}</span>}
        {agent.sessionId && agent.cwd && <span>{shortPath(agent.cwd)}</span>}
        <span>up {formatIdle(now - agent.startedAt)}</span>
        <span>{formatMemory(agent.memory)}</span>
        {agent.sessionId && <SessionUsageChip id={agent.sessionId} />}
      </span>
      {(agent.ports.length > 0 || agent.children.length > 0) && (
        <span className="agent-kids">
          {agent.ports.map((p) => <span key={p.port} className="agent-kid port">{p.name} :{p.port}</span>)}
          {agent.children.map((c) => <span key={c} className="agent-kid">{c}</span>)}
          {more > 0 && <span className="agent-kid">{more} more</span>}
        </span>
      )}
    </li>
  );
}

function StopConfirm({
  agents, withChildren: children, onChildren, onCancel, onStop
}: {
  agents: RunningAgent[];
  withChildren: boolean;
  onChildren: (v: boolean) => void;
  onCancel: () => void;
  onStop: () => void;
}) {
  const started = agents.some((a) => a.childCount > 0 || a.ports.length > 0);
  return (
    <div className="agents-confirm" role="dialog" aria-label="Stop agents">
      <strong>{agents.length === 1 ? `Stop ${agents[0].title}?` : `Stop ${agents.length} agents?`}</strong>
      <ul>
        {agents.map((a) => (
          <li key={a.key}>
            <b>{a.title}</b>{a.where ? ` (${a.where})` : ''}: {a.kind}
            {children && a.ports.length > 0 && `, and ${a.ports.map((p) => `${p.name} on :${p.port}`).join(', ')}`}
            {children && a.childCount > a.ports.length && `, and ${a.childCount - a.ports.length} other process${a.childCount - a.ports.length === 1 ? '' : 'es'} it started`}
          </li>
        ))}
      </ul>
      <span className="quick-card-meta">
        {agents.length === 1 ? 'Its terminal stays' : 'Their terminals stay'} open at a shell prompt, and the conversation
        {agents.length === 1 ? ' stays' : 's stay'} on disk, so <span className="mono">claude --resume</span> and{' '}
        <span className="mono">codex resume</span> still work.
      </span>
      <div className="agents-confirm-row">
        {started && (
          <label className="agents-check">
            <input type="checkbox" checked={children} onChange={(e) => onChildren(e.target.checked)} />
            Also stop the servers and processes {agents.length === 1 ? 'it' : 'they'} started
          </label>
        )}
        <span className="spacer" />
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
        <button type="button" className="agents-stop strong" onClick={onStop}>
          {agents.length === 1 ? 'Stop' : `Stop ${agents.length} agents`}
        </button>
      </div>
    </div>
  );
}

function shortPath(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  return parts.slice(-2).join('/') || '/';
}
