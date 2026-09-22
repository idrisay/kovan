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
  dedupeRepos,
  isBlocked,
  sortPulls,
  type JiraIssue,
  type ProviderId,
  type PullSummary,
  type RepoRef,
  type SentryIssue
} from '@baton/core';
import { Credentials, GitHubClient, HttpClient, JiraClient, SentryClient } from '@baton/providers';
import { findClones } from '@baton/git';
import { EventEmitter } from '@baton/host';
import type { DesktopHost } from './host';

/** The three providers the poller itself fetches queues from — the ones a
 *  "refresh just this one" control actually has something to do for.
 *  Grafana/Figma are connectable in Settings but never polled here. */
export type PolledProvider = 'github' | 'jira' | 'sentry';

export interface Snapshot {
  at: number;
  viewer: string;
  /** Yours, needing work before they can merge. The headline number. */
  blocked: PullSummary[];
  mine: PullSummary[];
  reviewRequested: PullSummary[];
  /** The most recently merged, newest first — a window onto `mergedTotal`. */
  merged: PullSummary[];
  /** How many merged pull requests exist, so "Show more" can say what it means. */
  mergedTotal: number;
  /** True while a "Show more" is in flight, for the footer's own spinner. */
  loadingMerged: boolean;
  tickets: JiraIssue[];
  sentryIssues: SentryIssue[];
  connected: ProviderId[];
  errors: { provider: ProviderId; message: string }[];
  refreshing: boolean;
  /** When each polled provider was last asked, whether or not it answered. */
  refreshedAt: Partial<Record<PolledProvider, number>>;
  /** Which polled providers a single-provider refresh is in flight for —
   *  distinct from `refreshing`, which is only ever true for a full refresh. */
  refreshingProviders: PolledProvider[];
}

export const EMPTY: Snapshot = {
  at: 0,
  viewer: '',
  blocked: [],
  mine: [],
  reviewRequested: [],
  merged: [],
  mergedTotal: 0,
  loadingMerged: false,
  tickets: [],
  sentryIssues: [],
  connected: [],
  errors: [],
  refreshing: false,
  refreshedAt: {},
  refreshingProviders: []
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
  private readonly refreshingProviders = new Set<PolledProvider>();

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

    const [github, jira, sentry] = await Promise.all([
      this.loadGitHub(connected, controller.signal, errors),
      this.loadJira(connected, controller.signal, errors),
      this.loadSentry(connected, controller.signal, errors)
    ]);

    if (controller.signal.aborted) {
      return this.snapshot;
    }

    const now = Date.now();
    const next: Snapshot = {
      at: now,
      viewer: github?.viewer ?? '',
      blocked: (github?.mine ?? []).filter((pull) => isBlocked(pull)),
      mine: github?.mine ?? [],
      reviewRequested: github?.reviewRequested ?? [],
      // A refresh resets the window to its first page. Keeping an expanded
      // list across refreshes would mean quietly re-fetching however many
      // pages the user had opened, on a timer, for the rest of the session.
      merged: github?.merged ?? [],
      mergedTotal: github?.mergedTotal ?? 0,
      loadingMerged: false,
      tickets: jira ?? [],
      sentryIssues: sentry ?? [],
      connected,
      errors,
      refreshing: false,
      refreshedAt: {
        ...this.snapshot.refreshedAt,
        ...(connected.includes('github') ? { github: now } : {}),
        ...(connected.includes('jira') ? { jira: now } : {}),
        ...(connected.includes('sentry') ? { sentry: now } : {})
      },
      refreshingProviders: []
    };
    this.publish(next);
    return next;
  }

  /**
   * Refreshes one provider's own queue, leaving the other's exactly as it
   * was — the "or can update just one of them" half of the timestamp menu.
   * Skipped entirely for a provider that is not connected: there is nothing
   * to ask, and stamping `refreshedAt` for it would claim a refresh that
   * never happened.
   */
  async refreshProvider(id: PolledProvider): Promise<Snapshot> {
    if (this.refreshingProviders.has(id)) {
      return this.snapshot;
    }
    const connected = await this.credentials.connected();
    if (!connected.includes(id)) {
      return this.snapshot;
    }

    this.refreshingProviders.add(id);
    this.publish({ ...this.snapshot, refreshingProviders: [...this.refreshingProviders] });

    const errors = this.snapshot.errors.filter((e) => e.provider !== id);
    const controller = new AbortController();

    let patch: Partial<Snapshot> = {};
    if (id === 'github') {
      const github = await this.loadGitHub(connected, controller.signal, errors);
      if (github) {
        patch = {
          viewer: github.viewer,
          blocked: github.mine.filter((pull) => isBlocked(pull)),
          mine: github.mine,
          reviewRequested: github.reviewRequested,
          merged: github.merged,
          mergedTotal: github.mergedTotal,
          loadingMerged: false
        };
      }
    } else if (id === 'jira') {
      const jira = await this.loadJira(connected, controller.signal, errors);
      if (jira) {
        patch = { tickets: jira };
      }
    } else {
      const sentry = await this.loadSentry(connected, controller.signal, errors);
      if (sentry) {
        patch = { sentryIssues: sentry };
      }
    }

    this.refreshingProviders.delete(id);
    const next: Snapshot = {
      ...this.snapshot,
      ...patch,
      connected,
      errors,
      refreshedAt: { ...this.snapshot.refreshedAt, [id]: Date.now() },
      refreshingProviders: [...this.refreshingProviders]
    };
    this.publish(next);
    return next;
  }

  /**
   * Widens the merged window and republishes.
   *
   * Deliberately not a `refresh()`: it must not be able to fail the open
   * queues, and it must not reset them either. On an error the list stays
   * exactly as it was and the error joins the snapshot's own list, so the
   * footer can say what went wrong without the sidebar going blank.
   */
  async loadMoreMerged(limit: number): Promise<Snapshot> {
    if (this.snapshot.loadingMerged) {
      return this.snapshot;
    }
    const token = await this.credentials.token('github');
    if (!token) {
      return this.snapshot;
    }

    this.publish({ ...this.snapshot, loadingMerged: true });
    try {
      const client = new GitHubClient(
        this.http,
        this.host.config.get('github.baseUrl', 'https://api.github.com'),
        token
      );
      const more = await client.mergedPulls(await this.scopedRepos(), limit);
      const next: Snapshot = {
        ...this.snapshot,
        merged: byMergedAt(more.pulls),
        mergedTotal: more.total,
        loadingMerged: false,
        errors: this.snapshot.errors.filter((e) => e.provider !== 'github')
      };
      this.publish(next);
      return next;
    } catch (err) {
      this.host.log.error('Loading more merged pull requests failed', err);
      const next: Snapshot = {
        ...this.snapshot,
        loadingMerged: false,
        errors: [
          ...this.snapshot.errors.filter((e) => e.provider !== 'github'),
          { provider: 'github' as const, message: message(err) }
        ]
      };
      this.publish(next);
      return next;
    }
  }

  private publish(snapshot: Snapshot): void {
    this.snapshot = snapshot;
    this.changed.fire(snapshot);
  }

  private async loadGitHub(
    connected: readonly ProviderId[],
    signal: AbortSignal,
    errors: Snapshot['errors']
  ): Promise<
    | {
        viewer: string;
        mine: PullSummary[];
        reviewRequested: PullSummary[];
        merged: PullSummary[];
        mergedTotal: number;
      }
    | undefined
  > {
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
        await this.scopedRepos(),
        this.host.config.get('github.limit', 50),
        signal
      );
      return {
        viewer: queues.viewer,
        mine: sortPulls(queues.mine, 'updated-desc'),
        reviewRequested: sortPulls(queues.reviewRequested, 'updated-desc'),
        merged: byMergedAt(queues.merged),
        mergedTotal: queues.mergedTotal
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
   * A single project's own unresolved issues, newest-seen first. No
   * auto-discovery across every project in the organization — `sentry.
   * project` is a required field (see `CREDENTIAL_FIELDS.sentry`) precisely
   * because there is nothing useful to fetch without one yet.
   */
  private async loadSentry(
    connected: readonly ProviderId[],
    signal: AbortSignal,
    errors: Snapshot['errors']
  ): Promise<SentryIssue[] | undefined> {
    if (!connected.includes('sentry')) {
      return undefined;
    }
    const token = await this.credentials.token('sentry');
    const organization = this.host.config.get('sentry.organization', '');
    const project = this.host.config.get('sentry.project', '');
    if (!token || !organization || !project) {
      return undefined;
    }
    try {
      const client = new SentryClient(
        this.http,
        this.host.config.get('sentry.baseUrl', 'https://sentry.io'),
        organization,
        token
      );
      return await client.listIssues(
        project,
        this.host.config.get('sentry.query', 'is:unresolved'),
        this.host.config.get('sentry.issuesLimit', 25),
        signal
      );
    } catch (err) {
      if (!signal.aborted) {
        errors.push({ provider: 'sentry', message: message(err) });
        this.host.log.error('Sentry refresh failed', err);
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
  /**
   * The repos to scope the queues to, from the active workspace's clones —
   * or `undefined` for the whole account.
   *
   * `undefined`, not `[]`: a workspace with no GitHub-backed clone yet (a
   * brand new folder, one not pushed anywhere) would otherwise scope the
   * queue to nothing and read as "no pull requests" instead of "nothing to
   * scope by yet". The account-wide queue is also what a user with no
   * workspace at all has always seen, so nothing changes for them.
   */
  private async scopedRepos(): Promise<RepoRef[] | undefined> {
    const workspaces = this.host.config.get<{ id: string; folders: string[] }[]>('workspaces', []);
    if (workspaces.length === 0) {
      return undefined;
    }
    const activeId = this.host.config.get<string | undefined>('workspace.active', undefined);
    const workspace = workspaces.find((w) => w.id === activeId) ?? workspaces[0];
    if (!workspace || workspace.folders.length === 0) {
      return undefined;
    }

    const clones = await findClones(workspace.folders);
    const repos = dedupeRepos(
      clones
        .map((clone) => clone.slug)
        .filter((slug): slug is string => Boolean(slug))
        .map((slug) => {
          const [owner, name] = slug.split('/');
          return { owner, name };
        })
    );
    return repos.length > 0 ? repos : undefined;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Newest merge first.
 *
 * On `mergedAt`, not `updatedAt`: a comment left today on something that
 * shipped in March should not push it above what shipped this morning. A row
 * without a merge date sorts last rather than being dropped — the field is
 * optional on the type, and losing a row to a missing timestamp would be a
 * worse failure than showing it at the bottom.
 */
function byMergedAt(pulls: readonly PullSummary[]): PullSummary[] {
  const at = (pull: PullSummary) => (pull.mergedAt ? Date.parse(pull.mergedAt) : 0);
  return [...pulls].sort((a, b) => at(b) - at(a));
}
