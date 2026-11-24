/**
 * When an agent Kovan started deserves a notification (item 182), and what
 * it says.
 *
 * The states come from the agent itself (item 112). Only two changes are
 * worth interrupting you for: the agent stopped to ask you something
 * (→ Input), or a turn of work ended (Working → Done). Everything else is
 * either you answering (Input → Working) or noise.
 */

export type AlertState = 'working' | 'input' | 'done';
export type AgentAlertKind = 'input' | 'done';

export interface AgentAlert {
  kind: AgentAlertKind;
  sessionId: string;
  /** The session's name as its row shows it. */
  title: string;
  /** Claude, Codex, OpenCode… */
  runnerName: string;
}

export interface AlertNotice {
  title: string;
  subtitle?: string;
  body: string;
  /** The session a click opens; unset for a summary of several. */
  sessionId?: string;
}

/**
 * The alert a change of state calls for, if any.
 *
 * The first word Kovan hears from a session (`from` unset) is never a change:
 * at launch every status file is read once, and announcing them would replay
 * the whole morning. Input → Done means you just answered and the turn ended
 * while you were there, so it stays quiet too.
 */
export function agentAlertKind(from: AlertState | undefined, to: AlertState): AgentAlertKind | undefined {
  if (from === undefined || from === to) return undefined;
  if (to === 'input') return 'input';
  if (to === 'done' && from === 'working') return 'done';
  return undefined;
}

/**
 * What macOS shows. One or two alerts get a notification each, so each one
 * opens its own session; more than that become one summary, as Activity does.
 * Input comes first: it is the one holding something up.
 */
export function agentAlertNotices(alerts: readonly AgentAlert[]): AlertNotice[] {
  if (alerts.length === 0) return [];
  const ordered = [...alerts].sort((a, b) => rank(a.kind) - rank(b.kind));
  if (ordered.length <= 2) {
    return ordered.map((alert) => ({
      title: alert.kind === 'input' ? 'Waiting for you' : 'Agent finished',
      subtitle: alert.runnerName,
      body: alert.title,
      sessionId: alert.sessionId
    }));
  }
  const input = ordered.filter((a) => a.kind === 'input').length;
  const done = ordered.length - input;
  const parts = [
    input ? `${input} waiting for you` : '',
    done ? `${done} finished` : ''
  ].filter(Boolean);
  return [{ title: 'Kovan', body: `${ordered.length} agents: ${parts.join(', ')}` }];
}

function rank(kind: AgentAlertKind): number {
  return kind === 'input' ? 0 : 1;
}
