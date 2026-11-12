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
  isGitHubLogin,
  personJql,
  projectKeys,
  rankTeammates,
  DEFAULT_TASKS_JQL,
  type PersonPulls,
  type PersonTickets,
  type Teammate,
  sortPulls,
  type JiraIssue,
  type JiraMention,
  type ProviderId,
  type PullSummary,
  type RepoRef,
  type SentryIssue,
  type GitHubBudget
} from '@kovan/core';
import { Credentials, GitHubClient, HttpClient, JiraClient, SentryClient, type TicketPull } from '@kovan/providers';
import { findClones } from '@kovan/git';
import { EventEmitter } from '@kovan/host';
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
  /** GitHub's GraphQL budget as of the last poll that got an answer (item 92). */
  githubBudget?: GitHubBudget;
  /**
   * Only during the very first refresh after launch (item 101): each polled
   * service that is connected, and how far it has got — what the startup
   * screen lists. Absent once everything has answered, and on every later
   * refresh (those keep showing the data they already have).
   */
  booting?: BootStep[];
  /**
   * For Activity (item 119), from the last Jira refresh: where you were
   * mentioned since the check before, and who assigned the newly listed
   * tickets. Absent when Jira wasn't asked or didn't say.
   */
  jiraMentions?: JiraMention[];
  jiraAssignedBy?: Record<string, string>;
}

export interface BootStep {
  provider: PolledProvider;
  state: 'loading' | 'done' | 'failed';
  /** How many items it brought back, once done. */
  count?: number;
  message?: string;
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
  /** Item 119: you as Jira knows you, what was checked, and what the last check found. */
  private jiraMe?: { accountId: string };
  private mentionsCheckedAt?: number;
  private lastTicketKeys?: Set<string>;
  private readonly assigners = new Map<string, string>();
  private jiraActivity: Pick<Snapshot, 'jiraMentions' | 'jiraAssignedBy'> = {};
  /** Item 164: the person picker's lists, asked on its first open, kept ten minutes. */
  private readonly teammateCache = new Map<'github' | 'jira', { at: number; people: Teammate[] }>();

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

    // The first refresh after launch (item 101): which services are
    // connected is known now, from the local credentials, and is published
    // at once — before, the window said "Nothing connected yet" until every
    // service had answered. Each service then reports in as it lands.
    const first = this.snapshot.at === 0;
    let booting: BootStep[] | undefined = first
      ? (['github', 'jira', 'sentry'] as const).filter((p) => connected.includes(p)).map((provider) => ({ provider, state: 'loading' as const }))
      : undefined;
    if (booting) this.publish({ ...this.snapshot, connected, refreshing: true, booting });
    const report = <T>(provider: PolledProvider, count: (value: T) => number) => (value: T) => {
      if (!booting || controller.signal.aborted) return value;
      const failed = errors.find((e) => e.provider === provider);
      booting = booting.map((step) => step.provider !== provider ? step
        : failed ? { provider, state: 'failed' as const, message: failed.message }
          : { provider, state: 'done' as const, count: count(value) });
      this.publish({ ...this.snapshot, booting });
      return value;
    };

    const [github, jira, sentry] = await Promise.all([
      this.loadGitHub(connected, controller.signal, errors)
        .then(report('github', (g) => (g ? g.mine.length + g.reviewRequested.length : 0))),
      this.loadJira(connected, controller.signal, errors).then(report('jira', (j) => j?.length ?? 0)),
      this.loadSentry(connected, controller.signal, errors).then(report('sentry', (e) => e?.length ?? 0))
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
      ...((github?.budget ?? this.snapshot.githubBudget) ? { githubBudget: github?.budget ?? this.snapshot.githubBudget } : {}),
      tickets: jira ?? [],
      ...(jira ? this.jiraActivity : {}),
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
          loadingMerged: false,
          ...(github.budget ? { githubBudget: github.budget } : {})
        };
      }
    } else if (id === 'jira') {
      const jira = await this.loadJira(connected, controller.signal, errors);
      if (jira) {
        patch = { tickets: jira, ...this.jiraActivity };
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

  /**
   * Who the person picker lists (item 164): GitHub, everyone with a pull
   * request in your repositories; Jira, everyone with a ticket in your
   * tickets' projects lately. Asked when the picker opens, never on a timer.
   */
  async teammates(service: 'github' | 'jira'): Promise<Teammate[]> {
    const cached = this.teammateCache.get(service);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.people;
    let people: Teammate[];
    if (service === 'github') {
      const client = await this.github();
      const repos = await this.scopedRepos();
      // No workspace: the owners of the repositories your own queues are in.
      const own = [...this.snapshot.mine, ...this.snapshot.reviewRequested, ...this.snapshot.merged];
      const owners = [...new Set(own.map((p) => p.repo.split('/')[0] ?? '').filter(isGitHubLogin))];
      const seen = await client.teammates(repos, owners);
      people = rankTeammates(seen.map((p) => ({ id: p.login, name: p.name, handle: p.login, open: p.open })), [this.snapshot.viewer]);
    } else {
      const client = await this.jira();
      const projects = projectKeys(this.snapshot.tickets);
      if (projects.length === 0) {
        people = [];
      } else {
        this.jiraMe ??= await client.myself();
        const seen = await client.assignees(
          `project in (${projects.join(', ')}) AND assignee is not EMPTY AND updated >= -90d ORDER BY updated DESC`, 100
        );
        people = rankTeammates(seen.map((p) => ({ id: p.accountId, name: p.name, open: p.open })), [this.jiraMe.accountId]);
      }
    }
    this.teammateCache.set(service, { at: Date.now(), people });
    return people;
  }

  /**
   * A ticket's pull requests (item 171), for "Review together": under the
   * owners of your repositories and of the pull requests in your queues.
   * Asked when the review sheet opens, never on a timer.
   */
  async ticketPulls(key: string): Promise<TicketPull[]> {
    const client = await this.github();
    const repos = await this.scopedRepos();
    const own = [...this.snapshot.mine, ...this.snapshot.reviewRequested, ...this.snapshot.merged];
    const owners = [...new Set([
      ...(repos ?? []).map((r) => r.owner),
      ...own.map((p) => p.repo.split('/')[0] ?? '')
    ].filter(isGitHubLogin))];
    if (owners.length === 0) return [];
    return client.ticketPulls(key, owners);
  }

  /** A teammate's pull requests, in your queues' scope (item 164). */
  async personPulls(login: string, merged: number): Promise<PersonPulls> {
    if (!isGitHubLogin(login)) throw new Error(`Not a GitHub login: ${login}`);
    const client = await this.github();
    const queues = await client.pullQueues(
      await this.scopedRepos(), this.host.config.get('github.limit', 50), undefined, merged, login
    );
    return {
      open: sortPulls(queues.mine, 'updated-desc'),
      reviewRequested: sortPulls(queues.reviewRequested, 'updated-desc'),
      merged: byMergedAt(queues.merged),
      mergedTotal: queues.mergedTotal
    };
  }

  /** A teammate's tickets: your ticket query, asked about them (item 164). */
  async personTickets(accountId: string): Promise<PersonTickets> {
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(accountId)) throw new Error('Not a Jira account id');
    const client = await this.jira();
    const tickets = await client.search(
      personJql(this.host.config.get('jira.tasksJql', DEFAULT_TASKS_JQL), accountId),
      this.host.config.get('jira.tasksLimit', 100)
    );
    return { tickets };
  }

  private async github(): Promise<GitHubClient> {
    const token = await this.credentials.token('github');
    if (!token) throw new Error('GitHub is not connected');
    return new GitHubClient(this.http, this.host.config.get('github.baseUrl', 'https://api.github.com'), token);
  }

  private async jira(): Promise<JiraClient> {
    const token = await this.credentials.token('jira');
    const site = this.host.config.get('jira.baseUrl', '');
    const email = this.host.config.get('jira.email', '');
    if (!token || !site || !email) throw new Error('Jira is not connected');
    return new JiraClient(this.http, site, email, token);
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
        budget?: GitHubBudget;
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
        mergedTotal: queues.mergedTotal,
        ...(queues.budget ? { budget: queues.budget } : {})
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
      const tickets = await client.search(
        this.host.config.get('jira.tasksJql', DEFAULT_TASKS_JQL),
        this.host.config.get('jira.tasksLimit', 100),
        signal
      );
      this.jiraActivity = await this.loadJiraActivity(client, tickets, signal);
      return tickets;
    } catch (err) {
      if (!signal.aborted) {
        errors.push({ provider: 'jira', message: message(err) });
        this.host.log.error('Jira refresh failed', err);
      }
      return undefined;
    }
  }

  /**
   * Mentions and assignments for Activity (item 119). Its own failures stay
   * its own: the ticket list is already in, and a mention check that didn't
   * answer is simply tried again next refresh, from the same point.
   */
  private async loadJiraActivity(
    client: JiraClient, tickets: readonly JiraIssue[], signal: AbortSignal
  ): Promise<Pick<Snapshot, 'jiraMentions' | 'jiraAssignedBy'>> {
    const out: Pick<Snapshot, 'jiraMentions' | 'jiraAssignedBy'> = {};
    try {
      this.jiraMe ??= await client.myself(signal);
      const me = this.jiraMe.accountId;

      // Who assigned the tickets new since the last refresh — at most a few
      // requests, and only when there is something new.
      const before = this.lastTicketKeys;
      this.lastTicketKeys = new Set(tickets.map((t) => t.key));
      if (before) {
        for (const ticket of tickets.filter((t) => !before.has(t.key)).slice(0, 5)) {
          const who = await client.assignedBy(ticket.key, me, signal).catch(() => undefined);
          if (who) this.assigners.set(ticket.key, who);
        }
      }
      const assignedBy = Object.fromEntries(tickets.filter((t) => this.assigners.has(t.key)).map((t) => [t.key, this.assigners.get(t.key)!]));
      if (Object.keys(assignedBy).length) out.jiraAssignedBy = assignedBy;

      if (this.host.config.get('activity.mentioned', true)) {
        const projects = [...new Set(tickets.map((t) => t.key.split('-')[0]!))];
        const startedAt = Date.now();
        // The first check looks back a little and sets the baseline.
        const since = this.mentionsCheckedAt ?? startedAt - 10 * 60_000;
        out.jiraMentions = await client.mentionsSince(me, projects, since, signal);
        // A minute's overlap: an edit landing mid-check is caught next time,
        // and Activity never reports the same mention twice.
        this.mentionsCheckedAt = startedAt - 60_000;
      }
    } catch (err) {
      if (!signal.aborted) this.host.log.warn('Jira mentions check failed', err);
    }
    return out;
  }

  /**
   * Unresolved issues, newest-seen first — every project in the organization
   * by default, since that is what "see all the project issues on my Sentry
   * account" means. `sentry.project` (not part of `CREDENTIAL_FIELDS.sentry`
   * — see the comment on `JIRA_EXTRA_FIELDS`'s sibling in Settings.tsx) narrows
   * that to one project for anyone who wants it scoped down instead.
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
    if (!token || !organization) {
      return undefined;
    }
    const project = this.host.config.get('sentry.project', '');
    try {
      const client = new SentryClient(
        this.http,
        this.host.config.get('sentry.baseUrl', 'https://sentry.io'),
        organization,
        token
      );
      const query = this.host.config.get('sentry.query', 'is:unresolved');
      const limit = this.host.config.get('sentry.issuesLimit', 25);
      return project
        ? await client.listIssues(project, query, limit, signal)
        : await client.listAllIssues(query, limit, signal);
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
