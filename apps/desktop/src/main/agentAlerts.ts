/**
 * A macOS notification when an agent Kovan started needs you or finishes
 * (item 182), the way Herdr's toasts work — from the status the agent reports
 * itself (item 112), never guessed from its output.
 *
 * Only while Kovan isn't in front: in front, the session's badge and the
 * Sessions rail pip already say it, and a notification on top would be the
 * same news twice (the rule Activity follows too).
 *
 * A change waits a moment before it is announced and is checked again then.
 * A permission prompt Claude's own allow-list answers flips Input → Working
 * at once, and a notification for something already over is noise.
 */

import { Notification } from 'electron';
import { agentAlertKind, agentAlertNotices, type AgentAlert, type AgentAlertKind } from '@kovan/core';
import type { DesktopHost } from './host';
import type { Sessions } from './sessions';

const SETTLE_MS = 1_500;

export const AGENT_ALERTS_SETTING = 'notify.agents';

export class AgentAlerts {
  private readonly pending = new Map<string, AgentAlertKind>();
  private timer?: ReturnType<typeof setTimeout>;
  private started = false;

  constructor(
    private readonly deps: {
      host: DesktopHost;
      sessions: Sessions;
      /** True while a Kovan window is the focused window of the app in front. */
      inFront: () => boolean;
      /** Brings Kovan forward on this session. */
      open: (sessionId: string) => void;
    }
  ) {}

  /**
   * Call once the status files have been read at launch: a state that
   * changed while Kovan was closed is already on its badge, not news.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.deps.sessions.onStatusChange(({ info, from, to }) => {
      const kind = agentAlertKind(from, to);
      if (kind) this.pending.set(info.id, kind);
      else this.pending.delete(info.id);
      if (this.pending.size > 0 && !this.timer) this.timer = setTimeout(() => this.flush(), SETTLE_MS);
    });
  }

  private flush(): void {
    this.timer = undefined;
    const alerts: AgentAlert[] = [];
    for (const [id, kind] of this.pending) {
      const info = this.deps.sessions.get(id);
      // Still in the state it was announced for: answered or closed in the
      // meantime means there is nothing to say.
      if (info?.running && info.status === kind) {
        alerts.push({ kind, sessionId: id, title: info.title, runnerName: info.runnerName });
      }
    }
    this.pending.clear();
    if (alerts.length === 0) return;

    const config = this.deps.host.config;
    if (!config.get('notify.enabled', true) || !config.get(AGENT_ALERTS_SETTING, true)) return;
    // A smoke run never reaches Notification Center: it would pop up on the
    // machine running it.
    if (process.env['KOVAN_SMOKE'] || !Notification.isSupported() || this.deps.inFront()) return;

    for (const notice of agentAlertNotices(alerts)) {
      const n = new Notification({
        title: notice.title,
        body: notice.body,
        ...(notice.subtitle ? { subtitle: notice.subtitle } : {})
      });
      const id = notice.sessionId;
      n.on('click', () => this.deps.open(id ?? ''));
      n.show();
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
