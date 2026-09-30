/**
 * The Activity inbox (item 86): review requests, approvals, changes
 * requested, new tickets and new comments, noticed by comparing each finished
 * poll with the one before (`diffActivity` in core, which has the rules).
 *
 * In main, like the poller, so it notices things with no window open. What it
 * noticed is kept in `activity-feed.json`, next to the older `activity.json`
 * that only remembers blocked pull requests for their notification.
 *
 * Delivery is the caller's: a toast when the window is in front, a macOS
 * notification when it isn't. The first poll after launch is compared with
 * what was saved at the last quit, so what happened while Baton was closed
 * lands in the inbox unread — but quietly, with no toast or notification for
 * each of them.
 */

import * as path from 'node:path';
import {
  ACTIVITY_KINDS, addActivity, diffActivity, githubAnswered,
  type ActivityEvent, type ActivityKind, type ActivityPoll, type ActivitySeen
} from '@baton/core';
import type { DesktopHost } from './host';
import type { Snapshot } from './poller';

interface Stored {
  seen: ActivitySeen;
  inbox: ActivityEvent[];
}

export class ActivityFeed {
  private readonly file: string;
  private state: Stored = { seen: {}, inbox: [] };
  private loaded?: Promise<void>;

  constructor(
    private readonly host: DesktopHost,
    private readonly onChange: (inbox: ActivityEvent[], fresh: ActivityEvent[], quiet: boolean) => void
  ) {
    this.file = path.join(host.files.stateDir(), 'activity-feed.json');
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const bytes = await this.host.files.read(this.file);
        const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<Stored>;
        this.state = { seen: parsed.seen ?? {}, inbox: Array.isArray(parsed.inbox) ? parsed.inbox : [] };
      } catch {
        this.state = { seen: {}, inbox: [] };
      }
    })();
    return this.loaded;
  }

  private async persist(): Promise<void> {
    await this.host.files.write(this.file, new TextEncoder().encode(JSON.stringify(this.state, null, 1)));
  }

  async inbox(): Promise<ActivityEvent[]> {
    await this.load();
    return this.state.inbox;
  }

  /** Which kinds you asked to hear about; Settings → Activity. All on by default. */
  private wanted(kind: ActivityKind): boolean {
    const setting = ACTIVITY_KINDS.find((k) => k.kind === kind)?.setting;
    return setting ? this.host.config.get<boolean>(setting, true) : true;
  }

  /**
   * Which providers really answered this poll. A failed one publishes empty
   * lists, and comparing those would be the flood `diffActivity` guards
   * against — so it's left out, and what was known about it is kept.
   */
  private pollOf(snapshot: Snapshot): ActivityPoll {
    const failed = (provider: string) => snapshot.errors.some((e) => e.provider === provider);
    const poll: ActivityPoll = {};
    if (githubAnswered(snapshot)) {
      poll.github = { viewer: snapshot.viewer, mine: snapshot.mine, reviewRequested: snapshot.reviewRequested };
    }
    const jiraSetUp = Boolean(this.host.config.get('jira.baseUrl', '') && this.host.config.get('jira.email', ''));
    if (snapshot.connected.includes('jira') && jiraSetUp && !failed('jira')) {
      poll.jira = {
        tickets: snapshot.tickets,
        ...(snapshot.jiraMentions ? { mentions: snapshot.jiraMentions } : {}),
        ...(snapshot.jiraAssignedBy ? { assignedBy: snapshot.jiraAssignedBy } : {})
      };
    }
    return poll;
  }

  /** @param quiet the first poll of a session: into the inbox, but no toasts. */
  async report(snapshot: Snapshot, quiet: boolean): Promise<void> {
    await this.load();
    const poll = this.pollOf(snapshot);
    if (!poll.github && !poll.jira) return;

    const { events, seen } = diffActivity(this.state.seen, poll);
    const wanted = events.filter((event) => this.wanted(event.kind));
    const inbox = addActivity(this.state.inbox, wanted);
    const known = new Set(this.state.inbox.map((event) => event.id));
    this.state = { seen, inbox };
    await this.persist();

    if (wanted.length > 0) {
      const fresh = inbox.filter((event) => !known.has(event.id));
      this.host.log.info(`Activity: ${fresh.map((e) => `${e.kind} ${e.subject}`).join(', ')}`);
      this.onChange(inbox, fresh, quiet);
    }
  }

  /** Marks events read — the ones given, or every one. */
  async markRead(ids: readonly string[] | 'all'): Promise<ActivityEvent[]> {
    await this.load();
    const which = ids === 'all' ? undefined : new Set(ids);
    let changed = false;
    this.state.inbox = this.state.inbox.map((event) => {
      if (event.read || (which && !which.has(event.id))) return event;
      changed = true;
      return { ...event, read: true };
    });
    if (changed) {
      await this.persist();
      this.onChange(this.state.inbox, [], true);
    }
    return this.state.inbox;
  }
}
