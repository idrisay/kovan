import type { CancelSignal } from '@baton/host';
import type { SentryIssue } from '@baton/core';
import type { HttpClient } from '../http';

/** The wire shape of one stack frame, before `resolveFrame()` places it on
 *  disk — that step needs Node's `path` and lives in `@baton/core/node`,
 *  which this package (built for the renderer too) cannot import. */
export interface RawSentryFrame {
  filename?: string;
  function?: string;
  lineNo?: number;
  colNo?: number;
  in_app?: boolean;
}

interface RawIssue {
  id: string;
  shortId: string;
  title: string;
  culprit: string;
  level: string;
  count: string | number;
  userCount: number;
  permalink: string;
  firstSeen: string;
  lastSeen: string;
  project?: { slug: string };
}

interface RawEvent {
  entries?: {
    type: string;
    data?: { values?: { stacktrace?: { frames?: RawSentryFrame[] } }[]; frames?: RawSentryFrame[] };
  }[];
}

/**
 * Ported from `devhub/src/providers/sentry/SentryClient.ts`, the VS Code
 * extension's own working client — the only change is the cancellation
 * mechanism, `AbortSignal`-shaped `CancelSignal` instead of
 * `vscode.CancellationToken`, the same swap every other provider here made.
 */
export class SentryClient {
  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl: string,
    private readonly organization: string,
    private readonly token: string
  ) {}

  private get headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  private api(path: string): string {
    return `${this.baseUrl}/api/0${path}`;
  }

  async listIssues(project: string, query: string, limit = 25, signal?: CancelSignal): Promise<SentryIssue[]> {
    const url = this.api(
      `/projects/${encodeURIComponent(this.organization)}/${encodeURIComponent(project)}/issues/` +
        `?query=${encodeURIComponent(query)}&limit=${limit}&statsPeriod=14d`
    );
    const raw = await this.http.json<RawIssue[]>(url, { headers: this.headers, signal });
    return (raw ?? []).map((issue) => this.mapIssue(issue, project));
  }

  /**
   * Every unresolved issue in the organization, across every project the
   * token can see — not one project's worth. The org-level search endpoint
   * is what Sentry's own issue stream uses when no project is picked in its
   * own UI; the project-scoped endpoint above has no such "all of them" mode
   * of its own, which is why this is a second method rather than `project`
   * going optional on `listIssues`.
   */
  async listAllIssues(query: string, limit = 25, signal?: CancelSignal): Promise<SentryIssue[]> {
    const url = this.api(
      `/organizations/${encodeURIComponent(this.organization)}/issues/` +
        `?query=${encodeURIComponent(query)}&limit=${limit}&statsPeriod=14d`
    );
    const raw = await this.http.json<RawIssue[]>(url, { headers: this.headers, signal });
    return (raw ?? []).map((issue) => this.mapIssue(issue));
  }

  private mapIssue(issue: RawIssue, fallbackProject = ''): SentryIssue {
    return {
      id: issue.id,
      shortId: issue.shortId,
      title: issue.title,
      culprit: issue.culprit,
      level: issue.level,
      count: Number(issue.count) || 0,
      userCount: issue.userCount ?? 0,
      permalink: issue.permalink,
      project: issue.project?.slug ?? fallbackProject,
      firstSeen: issue.firstSeen,
      lastSeen: issue.lastSeen
    };
  }

  /** The latest event is where the stack trace lives — the issue itself has none. */
  async getLatestFrames(issueId: string, signal?: CancelSignal): Promise<RawSentryFrame[]> {
    const event = await this.http.json<RawEvent>(
      this.api(`/issues/${encodeURIComponent(issueId)}/events/latest/`),
      { headers: this.headers, signal }
    );

    const entry = event.entries?.find((e) => e.type === 'exception' || e.type === 'stacktrace');
    if (!entry) {
      return [];
    }

    const frames = entry.data?.values?.flatMap((v) => v.stacktrace?.frames ?? []) ?? entry.data?.frames ?? [];

    // Sentry returns frames outermost-first; the throw site is last.
    return [...frames].reverse();
  }

  async verify(signal?: CancelSignal): Promise<string> {
    const org = await this.http.json<{ name: string }>(
      this.api(`/organizations/${encodeURIComponent(this.organization)}/`),
      { headers: this.headers, signal }
    );
    return org.name;
  }

  async listProjects(signal?: CancelSignal): Promise<string[]> {
    const projects = await this.http.json<{ slug: string }[]>(
      this.api(`/organizations/${encodeURIComponent(this.organization)}/projects/`),
      { headers: this.headers, signal }
    );
    return (projects ?? []).map((p) => p.slug);
  }
}
