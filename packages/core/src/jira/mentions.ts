/**
 * Jira mentions of you (item 119). Jira keeps a mention as a node carrying
 * the person's account id, so "mentions you" is exact: the name in the text
 * could be anybody's, the id can't.
 */

import { adfToMarkdown } from './adf';

/** One place a ticket mentions you: a comment, or the description. */
export interface JiraMention {
  key: string;
  summary: string;
  url: string;
  /** The comment's id, or `description`. */
  where: string;
  /** Who wrote it. */
  who?: string;
  /** The first words of what they wrote. */
  excerpt: string;
  /** When it was written, epoch ms. */
  at: number;
}

/** Whether an ADF document mentions the account. */
export function adfMentions(doc: unknown, accountId: string): boolean {
  if (!doc || typeof doc !== 'object') return false;
  const node = doc as { type?: string; attrs?: { id?: unknown }; content?: unknown[] };
  if (node.type === 'mention' && node.attrs?.id === accountId) return true;
  return Array.isArray(node.content) && node.content.some((child) => adfMentions(child, accountId));
}

/** The first words of an ADF document, on one line. */
export function adfExcerpt(doc: unknown, max = 160): string {
  const text = adfToMarkdown(doc).replace(/[*_`>#[\]]/g, '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

interface RawMentionIssue {
  key: string;
  fields: {
    summary?: string;
    description?: unknown;
    created?: string;
    updated?: string;
    reporter?: { accountId?: string; displayName?: string };
    comment?: { comments?: { id: string; author?: { accountId?: string; displayName?: string }; body?: unknown; created: string; updated?: string }[] };
  };
}

/**
 * Where these issues mention you since `since`: comments written or edited
 * since then, and a description when the issue was created since then. Your
 * own words never count.
 */
export function mentionsIn(
  issues: readonly RawMentionIssue[],
  me: string,
  since: number,
  browse: (key: string) => string
): JiraMention[] {
  const found: JiraMention[] = [];
  for (const issue of issues) {
    const { fields } = issue;
    const summary = fields.summary ?? issue.key;
    const created = Date.parse(fields.created ?? '');
    if (created >= since && fields.reporter?.accountId !== me && adfMentions(fields.description, me)) {
      found.push({
        key: issue.key, summary, url: browse(issue.key), where: 'description',
        ...(fields.reporter?.displayName ? { who: fields.reporter.displayName } : {}),
        excerpt: adfExcerpt(fields.description), at: created
      });
    }
    for (const comment of fields.comment?.comments ?? []) {
      const at = Math.max(Date.parse(comment.created), Date.parse(comment.updated ?? '') || 0);
      if (!(at >= since) || comment.author?.accountId === me || !adfMentions(comment.body, me)) continue;
      found.push({
        key: issue.key, summary, url: `${browse(issue.key)}?focusedCommentId=${comment.id}`, where: comment.id,
        ...(comment.author?.displayName ? { who: comment.author.displayName } : {}),
        excerpt: adfExcerpt(comment.body), at
      });
    }
  }
  return found.sort((a, b) => a.at - b.at);
}
