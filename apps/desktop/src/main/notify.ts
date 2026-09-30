/**
 * Notifications, and the state that stops them repeating.
 *
 * The rule is transitions only: you hear when a pull request *becomes* blocked,
 * not every minute that it stays blocked. That state is kept in `activity.json`
 * in the same shape the Swift app used, so an imported file keeps working and
 * the first refresh after a migration stays quiet instead of announcing your
 * entire backlog.
 */

import { Notification, shell } from 'electron';
import * as path from 'node:path';
import { githubAnswered, type PullSummary } from '@kovan/core';
import type { DesktopHost } from './host';
import type { Snapshot } from './poller';

/** What a notification says; shown by macOS unless a test collects it instead. */
export interface BlockedNotice { title: string; body: string; subtitle?: string; url?: string }

interface Seen {
  /** `repo#number` → the flags it was last seen blocked by. */
  blocked: Record<string, string>;
}

export class Activity {
  private readonly file: string;
  private seen: Seen = { blocked: {} };
  private loaded = false;

  constructor(
    private readonly host: DesktopHost,
    private readonly show: (notice: BlockedNotice) => void = showNotice
  ) {
    this.file = path.join(host.files.stateDir(), 'activity.json');
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      const bytes = await this.host.files.read(this.file);
      this.seen = JSON.parse(new TextDecoder().decode(bytes)) as Seen;
      this.seen.blocked ??= {};
    } catch {
      this.seen = { blocked: {} };
    }
  }

  private async persist(): Promise<void> {
    await this.host.files.write(
      this.file,
      new TextEncoder().encode(JSON.stringify(this.seen, null, 2))
    );
  }

  /**
   * @param first true on the very first refresh of a session, which records
   *              state without notifying. Without it, launching the app would
   *              fire one notification per already-blocked pull request.
   */
  async report(snapshot: Snapshot, first: boolean): Promise<void> {
    // A poll GitHub didn't answer has an empty blocked list, which is not
    // "nothing is blocked". Recording it made the next good poll announce
    // every blocked pull request as newly blocked (item 92). Keep what was
    // seen, and compare the next real answer with that.
    if (!githubAnswered(snapshot)) return;
    const blocked: readonly PullSummary[] = snapshot.blocked;
    await this.load();

    const now: Record<string, string> = {};
    const fresh: PullSummary[] = [];

    for (const pull of blocked) {
      const id = `${pull.repo}#${pull.number}`;
      const state = `${pull.mergeable}|${pull.reviewDecision}|${pull.checks}`;
      now[id] = state;
      if (this.seen.blocked[id] !== state) {
        fresh.push(pull);
      }
    }

    this.seen = { blocked: now };
    await this.persist();

    if (first || fresh.length === 0 || !this.host.config.get('notify.enabled', true)) {
      return;
    }

    if (fresh.length === 1) {
      const pull = fresh[0]!;
      this.show({ title: `${pull.repo} #${pull.number}`, body: pull.title, subtitle: 'Blocked on you', url: pull.url });
      return;
    }
    this.show({ title: 'Kovan', body: `${fresh.length} pull requests are now blocked on you` });
  }
}

function showNotice(notice: BlockedNotice): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: notice.title,
    body: notice.body,
    ...(notice.subtitle ? { subtitle: notice.subtitle } : {})
  });
  if (notice.url) {
    const url = notice.url;
    notification.on('click', () => void shell.openExternal(url));
  }
  notification.show();
}
