/**
 * The refresh loop, and the reason this app exists.
 *
 * It lives in the main process on purpose. The extension it replaces could
 * only tell you something was blocked while VS Code was open on the right
 * workspace; if this loop were in the renderer it would inherit exactly that
 * limitation, just with a different editor. Nothing here touches a window, and
 * everything keeps running when every window is closed.
 */

import {
  isBlocked,
  sortPulls,
  type JiraIssue,
  type ProviderId,
  type PullSummary,
  type RepoRef
} from '@baton/core';
import { Credentials, GitHubClient, HttpClient, JiraClient } from '@baton/providers';
import { EventEmitter } from '@baton/host';
import type { DesktopHost } from './host';

export interface Snapshot {
  at: number;
  viewer: string;
  /** Yours, needing work before they can merge. The headline number. */
  blocked: PullSummary[];
  mine: PullSummary[];
  reviewRequested: PullSummary[];
  tickets: JiraIssue[];
  connected: ProviderId[];
  errors: { provider: ProviderId; message: string }[];
  refreshing: boolean;
}

export const EMPTY: Snapshot = {
  at: 0,
  viewer: '',
  blocked: [],
  mine: [],
  reviewRequested: [],
  tickets: [],
  connected: [],
  errors: [],
  refreshing: false
};

export class Poller {
  private readonly http: HttpClient;
  private readonly credentials: Credentials;
  private readonly changed = new EventEmitter<Snapshot>();
  readonly onDidChange = this.changed.event;

  private snapshot: Snapshot = EMPTY;
  private timer?: NodeJS.Timeout;
  private inFlight?: AbortController;
  private lastRun = 0;

  constructor(private readonly host: DesktopHost) {
    this.http = new HttpClient(host.log);
    this.credentials = new Credentials(host);
  }

  current(): Snapshot {
    return this.snapshot;
  }

  start(): void {
    void this.refresh();
    // A fixed tick, with `minIntervalSeconds` enforced inside refresh(), so
    // changing the setting takes effect without restarting the timer.
    this.timer = setInterval(() => void this.refresh(), 60_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.inFlight?.abort();
    this.changed.dispose();
    this.credentials.dispose();
  }

  /**
   * @param force ignores the minimum interval — for the user asking, never for
   *              a timer.
   */
  async refresh(force = false): Promise<Snapshot> {
    const floor = this.host.config.get('refresh.minIntervalSeconds', 15) * 1000;
    if (!force && Date.now() - this.lastRun < floor) {
      return this.snapshot;
    }

    // A refresh already running is abandoned rather than awaited: its answer is
    // staler than the one about to be asked for.
    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;
    this.lastRun = Date.now();

    this.publish({ ...this.snapshot, refreshing: true });

    const errors: Snapshot['errors'] = [];
    const connected = await this.credentials.connected();

    const [github, jira] = await Promise.all([
      this.loadGitHub(connected, controller.signal, errors),
      this.loadJira(connected, controller.signal, errors)
    ]);

    if (controller.signal.aborted) {
      return this.snapshot;
    }

    const next: Snapshot = {
      at: Date.now(),
      viewer: github?.viewer ?? '',
      blocked: (github?.mine ?? []).filter((pull) => isBlocked(pull)),
      mine: github?.mine ?? [],
      reviewRequested: github?.reviewRequested ?? [],
      tickets: jira ?? [],
      connected,
      errors,
      refreshing: false
    };
    this.publish(next);
    return next;
  }

  private publish(snapshot: Snapshot): void {
    this.snapshot = snapshot;
    this.changed.fire(snapshot);
  }

  private async loadGitHub(
    connected: readonly ProviderId[],
    signal: AbortSignal,
    errors: Snapshot['errors']
  ): Promise<{ viewer: string; mine: PullSummary[]; reviewRequested: PullSummary[] } | undefined> {
    if (!connected.includes('github') || !this.host.config.get('github.enabled', true)) {
      return undefined;
    }
    const token = await this.credentials.token('github');
    if (!token) {
      return undefined;
    }
    try {
      const client = new GitHubClient(
        this.http,
        this.host.config.get('github.baseUrl', 'https://api.github.com'),
        token
      );
      const queues = await client.pullQueues(
        this.scopedRepos(),
        this.host.config.get('github.limit', 50),
        signal
      );
      return {
        viewer: queues.viewer,
        mine: sortPulls(queues.mine, 'updated-desc'),
        reviewRequested: sortPulls(queues.reviewRequested, 'updated-desc')
      };
    } catch (err) {
      if (!signal.aborted) {
        errors.push({ provider: 'github', message: message(err) });
        this.host.log.error('GitHub refresh failed', err);
      }
      return undefined;
    }
  }

  private async loadJira(
    connected: readonly ProviderId[],
    signal: AbortSignal,
    errors: Snapshot['errors']
  ): Promise<JiraIssue[] | undefined> {
    if (!connected.includes('jira')) {
      return undefined;
    }
    const token = await this.credentials.token('jira');
    const site = this.host.config.get('jira.baseUrl', '');
    const email = this.host.config.get('jira.email', '');
    if (!token || !site || !email) {
      return undefined;
    }
    try {
      const client = new JiraClient(this.http, site, email, token);
      return await client.search(
        this.host.config.get(
          'jira.tasksJql',
          'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'
        ),
        this.host.config.get('jira.tasksLimit', 100),
        signal
      );
    } catch (err) {
      if (!signal.aborted) {
        errors.push({ provider: 'jira', message: message(err) });
        this.host.log.error('Jira refresh failed', err);
      }
      return undefined;
    }
  }

  /**
   * Which repositories the queues are scoped to.
   *
   * Empty means the whole account, which is the default and the right one for
   * a standalone app: you want the pull request from the repo you have not
   * cloned yet. The other two modes come from the Swift app's workspaces
   * design — see devhub-mac/README.md, "there is no workspace *by default*".
   */
  private scopedRepos(): RepoRef[] | undefined {
    // `undefined` is unscoped — the whole account — and is both the default
    // and the right answer for a standalone app: you want the pull request
    // from the repo you have not cloned yet. Returning `[]` here would mean
    // "scoped to no repositories" and silently show an empty queue.
    //
    // Folder and workspace scoping need the clone index from `@baton/git`,
    // which lands with the explorer.
    return undefined;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
