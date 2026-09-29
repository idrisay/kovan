import type { LimitWindow } from '@baton/core';
import type { RunnerLimits } from './types';

/**
 * An agent's plan limits under the run sheet's Agent picker (item 108): each
 * window as a small meter with its percentage and when it resets, and how old
 * the numbers are. They come from what the agent last wrote on this Mac, so a
 * window whose reset time has passed shows as reset rather than stale.
 */

function when(ms: number, now: number): string {
  const date = new Date(ms);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const days = Math.floor((ms - now) / 86_400_000);
  const sameDay = date.toDateString() === new Date(now).toDateString();
  if (sameDay) return time;
  if (days < 6) return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function ago(ms: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - ms) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

function tone(w: LimitWindow): string {
  return w.usedPercent >= 90 ? 'fail' : w.usedPercent >= 70 ? 'running' : 'pass';
}

export function AgentLimitsNote({ entry }: { entry?: RunnerLimits }) {
  if (!entry) return null;
  const now = Date.now();
  const { limits, day } = entry;
  if (limits) {
    return (
      <div className="agent-limits" title={`From ${limits.source}${limits.plan ? ` · ${limits.plan} plan` : ''}. Baton sends no request for these.`}>
        {limits.windows.map((w) => (
          <div key={w.label} className={`agent-limit ${w.reset ? 'reset' : tone(w)}`}>
            <span className="agent-limit-label">{w.label}</span>
            <span className="agent-limit-bar" aria-hidden="true"><i style={{ width: `${Math.max(2, w.usedPercent)}%` }} /></span>
            <span className="agent-limit-value">
              {w.reset ? 'reset' : `${Math.round(w.usedPercent)}%`}
              {!w.reset && w.resetsAt ? ` · resets ${when(w.resetsAt, now)}` : ''}
            </span>
          </div>
        ))}
        <div className="agent-limits-age">
          as of {ago(limits.asOf, now)}{limits.plan ? ` · ${limits.plan}` : ''}
          {limits.shared ? ' · from your status line, last Claude account used' : ''}
        </div>
      </div>
    );
  }
  if (day) {
    const total = day.requests.reduce((n, r) => n + r.count, 0);
    return (
      <div className="agent-limits" title="From OpenCode's own records. It has no plan windows: each provider sets its own limits.">
        <div className="agent-limits-age">
          Today: {total} request{total === 1 ? '' : 's'}
          {day.requests.length > 0 ? ` — ${day.requests.slice(0, 3).map((r) => `${r.provider} ${r.count}`).join(' · ')}` : ''}
        </div>
        {day.limited && (
          <div className="agent-limit fail" title={day.limited.message}>
            <span className="agent-limit-value">{day.limited.provider} hit its limit {ago(day.limited.at, now)}</span>
          </div>
        )}
      </div>
    );
  }
  return null;
}
