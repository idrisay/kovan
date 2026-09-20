import type { CancelSignal } from '@baton/host';
import { adfToMarkdown, markdownToAdf, type JiraIssue, type JiraTransition } from '@baton/core';
import { HttpError, type HttpClient } from '../http';

interface RawIssue {
  key: string;
  fields: {
    summary: string;
    description?: unknown;
    status?: { name: string; statusCategory?: { key: string } };
    issuetype?: { name: string };
    priority?: { name: string };
    assignee?: { displayName: string };
    updated?: string;
    subtasks?: { key: string; fields: { summary: string; status?: { name: string } } }[];
    comment?: { comments: { author?: { displayName: string }; body?: unknown; created: string }[] };
  };
}

const FIELDS =
  'summary,description,status,issuetype,priority,assignee,updated,subtasks,comment';

const URL_PATTERN = /https?:\/\/[^\s<>()[\]"']+/g;

export class JiraClient {
  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl: string,
    private readonly email: string,
    private readonly token: string
  ) {}

  private get headers(): Record<string, string> {
    const basic = Buffer.from(`${this.email}:${this.token}`).toString('base64');
    return { Authorization: `Basic ${basic}` };
  }

  private api(path: string): string {
    return `${this.baseUrl}/rest/api/3${path}`;
  }

  browseUrl(key: string): string {
    return `${this.baseUrl}/browse/${key}`;
  }

  async getIssue(key: string, signal?: CancelSignal): Promise<JiraIssue> {
    const raw = await this.http.json<RawIssue>(this.api(`/issue/${encodeURIComponent(key)}?fields=${FIELDS}`), {
      headers: this.headers,
      signal
    });
    return this.normalise(raw);
  }

  async search(jql: string, limit = 30, signal?: CancelSignal): Promise<JiraIssue[]> {
    const response = await this.http.json<{ issues: RawIssue[] }>(this.api('/search/jql'), {
      method: 'POST',
      headers: this.headers,
      body: { jql, maxResults: limit, fields: FIELDS.split(',') },
      signal
    });
    return (response.issues ?? []).map((raw) => this.normalise(raw));
  }

  /**
   * Transitions are workflow-specific and can't be hardcoded — always read the
   * available set for the issue rather than assuming a name maps to an id.
   */
  async getTransitions(key: string, signal?: CancelSignal): Promise<JiraTransition[]> {
    const response = await this.http.json<{
      transitions: { id: string; name: string; to?: { name: string } }[];
    }>(this.api(`/issue/${encodeURIComponent(key)}/transitions`), { headers: this.headers, signal });
    return (response.transitions ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      to: t.to?.name ?? t.name
    }));
  }

  /**
   * Priority names in the site's own rank order, most urgent first. Sorting a
   * task list by priority is meaningless without this — the names are per-site
   * configuration and carry no order of their own.
   *
   * `/priority` was deprecated in favour of the paginated `/priority/search`,
   * and which one answers depends on the site's version, so both shapes are
   * accepted.
   */
  async getPriorities(signal?: CancelSignal): Promise<string[]> {
    const read = async (path: string): Promise<string[]> => {
      const response = await this.http.json<{ name: string }[] | { values?: { name: string }[] }>(
        this.api(path),
        { headers: this.headers, signal }
      );
      const values = Array.isArray(response) ? response : (response.values ?? []);
      return values.map((p) => p.name).filter((name): name is string => Boolean(name));
    };
    try {
      return await read('/priority/search?maxResults=100');
    } catch (err) {
      if ((err as HttpError)?.status !== 404) {
        throw err;
      }
      return read('/priority');
    }
  }

  async transition(key: string, transitionId: string): Promise<void> {
    await this.http.json(this.api(`/issue/${encodeURIComponent(key)}/transitions`), {
      method: 'POST',
      headers: this.headers,
      body: { transition: { id: transitionId } },
      mutating: true
    });
  }

  async addComment(key: string, body: string): Promise<void> {
    await this.http.json(this.api(`/issue/${encodeURIComponent(key)}/comment`), {
      method: 'POST',
      headers: this.headers,
      body: { body: markdownToAdf(body) },
      mutating: true
    });
  }

  async verify(signal?: CancelSignal): Promise<string> {
    const me = await this.http.json<{ displayName: string }>(this.api('/myself'), {
      headers: this.headers,
      signal
    });
    return me.displayName;
  }

  private normalise(raw: RawIssue): JiraIssue {
    const description = adfToMarkdown(raw.fields.description);
    const comments = (raw.fields.comment?.comments ?? []).map((c) => ({
      author: c.author?.displayName ?? 'Unknown',
      body: adfToMarkdown(c.body),
      created: c.created
    }));

    const haystack = [description, ...comments.map((c) => c.body)].join('\n');
    const links = [...new Set(haystack.match(URL_PATTERN) ?? [])];

    return {
      key: raw.key,
      summary: raw.fields.summary,
      description,
      status: raw.fields.status?.name ?? 'Unknown',
      statusCategory: raw.fields.status?.statusCategory?.key ?? 'undefined',
      issueType: raw.fields.issuetype?.name ?? 'Task',
      priority: raw.fields.priority?.name,
      assignee: raw.fields.assignee?.displayName,
      updated: raw.fields.updated ?? '',
      url: this.browseUrl(raw.key),
      subtasks: (raw.fields.subtasks ?? []).map((s) => ({
        key: s.key,
        summary: s.fields.summary,
        status: s.fields.status?.name ?? 'Unknown',
        url: this.browseUrl(s.key)
      })),
      comments,
      links
    };
  }
}
