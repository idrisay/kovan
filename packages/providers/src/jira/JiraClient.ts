import type { CancelSignal } from '@baton/host';
import {
  JIRA_MEDIA_PATTERN,
  adfToMarkdown,
  markdownToAdf,
  type JiraIssue,
  type JiraTransition
} from '@baton/core';
import { HttpError, type HttpClient } from '../http';

interface RawAttachment {
  id: string;
  filename: string;
  content: string;
  mimeType?: string;
}

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
    attachment?: RawAttachment[];
  };
}

const FIELDS =
  'summary,description,status,issuetype,priority,assignee,updated,subtasks,comment,attachment';

/**
 * Screenshots run a few hundred KB; past this an inline image would cost more
 * than a description picture is worth, so it is left as the plain-text note
 * instead of pulled in.
 */
const MAX_INLINE_ATTACHMENT_BYTES = 6 * 1024 * 1024;

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

  /**
   * The single issue somebody opened, with its inline screenshots resolved to
   * real images rather than `search()`'s plain-text notes.
   *
   * Resolving them costs one authenticated fetch per distinct image, which is
   * fine for the one ticket somebody is reading and would not be for the up
   * to 100 that `search()` returns on every poll.
   */
  async getIssue(key: string, signal?: CancelSignal): Promise<JiraIssue> {
    const raw = await this.http.json<RawIssue>(this.api(`/issue/${encodeURIComponent(key)}?fields=${FIELDS}`), {
      headers: this.headers,
      signal
    });
    return this.withInlineAttachments(this.normalise(raw), raw, signal);
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

  /**
   * Swaps the issue's `jira-media:` placeholders for real inline images.
   *
   * The only thread back from an ADF media node to a classic attachment is
   * its filename — matched here against `fields.attachment`, which is the
   * one call that names both a filename and a byte-serving URL.
   */
  private async withInlineAttachments(
    issue: JiraIssue,
    raw: RawIssue,
    signal?: CancelSignal
  ): Promise<JiraIssue> {
    const byFilename = new Map(
      (raw.fields.attachment ?? [])
        .filter((a) => a.filename && a.content)
        .map((a) => [a.filename, a] as const)
    );
    // Not an early exit for an empty map: a description can still hold
    // `jira-media:` tokens with nothing in `fields.attachment` to match them
    // against, and those still have to come back down to the plain-text note
    // — left as the token, they would reach `Prose` as an `<img>` with a
    // scheme DOMPurify does not allow and simply vanish.
    const [description, comments] = await Promise.all([
      this.resolveAttachments(issue.description, byFilename, signal),
      Promise.all(
        issue.comments.map(async (c) => ({
          ...c,
          body: await this.resolveAttachments(c.body, byFilename, signal)
        }))
      )
    ]);
    return { ...issue, description, comments };
  }

  private async resolveAttachments(
    markdown: string,
    byFilename: Map<string, RawAttachment>,
    signal?: CancelSignal
  ): Promise<string> {
    const filenames = [...new Set(
      [...markdown.matchAll(JIRA_MEDIA_PATTERN)].map(([, , encoded]) => decodeURIComponent(encoded))
    )];
    if (filenames.length === 0) {
      return markdown;
    }

    const dataUrls = new Map<string, string>();
    await Promise.all(
      filenames.map(async (filename) => {
        const attachment = byFilename.get(filename);
        if (!attachment) return;
        try {
          const dataUrl = await this.attachmentDataUrl(attachment, signal);
          if (dataUrl) dataUrls.set(filename, dataUrl);
        } catch {
          // Left unresolved — the replace below falls back to the note.
        }
      })
    );

    return markdown.replace(JIRA_MEDIA_PATTERN, (_whole, alt: string, encoded: string) => {
      const dataUrl = dataUrls.get(decodeURIComponent(encoded));
      return dataUrl ? `![${alt}](${dataUrl})` : `_(attachment: ${alt || 'file'})_`;
    });
  }

  private async attachmentDataUrl(
    attachment: RawAttachment,
    signal?: CancelSignal
  ): Promise<string | undefined> {
    if (attachment.mimeType && !attachment.mimeType.startsWith('image/')) {
      return undefined;
    }
    const { bytes, contentType } = await this.http.binary(attachment.content, {
      headers: this.headers,
      signal
    });
    const mime = attachment.mimeType || contentType;
    if (!mime.startsWith('image/') || bytes.byteLength === 0 || bytes.byteLength > MAX_INLINE_ATTACHMENT_BYTES) {
      return undefined;
    }
    return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
  }
}
