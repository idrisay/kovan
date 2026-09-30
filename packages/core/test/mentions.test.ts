import { describe, expect, it } from 'vitest';
import { adfMentions, diffActivity, mentionsIn, type JiraIssue, type JiraMention } from '../src';

const ME = 'acc-me';
const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content }] });
const text = (t: string) => ({ type: 'text', text: t });
const mention = (id: string, name: string) => ({ type: 'mention', attrs: { id, text: `@${name}` } });
const browse = (key: string) => `https://jira.example/browse/${key}`;

describe('adfMentions', () => {
  it('finds a mention by account id, not by name', () => {
    expect(adfMentions(doc(text('hey '), mention(ME, 'Idris')), ME)).toBe(true);
    expect(adfMentions(doc(text('hey @Idris')), ME)).toBe(false);
    expect(adfMentions(doc(mention('someone-else', 'Idris')), ME)).toBe(false);
  });
});

describe('mentionsIn', () => {
  const issue = {
    key: 'ACME-2453',
    fields: {
      summary: 'Parent performance page',
      created: '2026-09-01T10:00:00Z',
      reporter: { accountId: 'acc-gio', displayName: 'Giovanni' },
      description: doc(text('Owner: '), mention(ME, 'Idris')),
      comment: {
        comments: [
          { id: '100', author: { accountId: 'acc-gio', displayName: 'Giovanni' }, body: doc(mention(ME, 'Idris'), text(' can you check the parent view?')), created: '2026-09-30T14:00:00Z' },
          { id: '101', author: { accountId: ME, displayName: 'Idris' }, body: doc(mention(ME, 'Idris'), text(' note to self')), created: '2026-09-30T14:01:00Z' },
          { id: '99', author: { accountId: 'acc-gio', displayName: 'Giovanni' }, body: doc(mention(ME, 'Idris'), text(' old')), created: '2026-09-29T09:00:00Z' }
        ]
      }
    }
  };

  it('reports comments since the last check that mention you, not your own, and not an old description', () => {
    const found = mentionsIn([issue], ME, Date.parse('2026-09-30T13:00:00Z'), browse);
    expect(found).toEqual([{
      key: 'ACME-2453', summary: 'Parent performance page', url: 'https://jira.example/browse/ACME-2453?focusedCommentId=100',
      where: '100', who: 'Giovanni', excerpt: '@Idris can you check the parent view?', at: Date.parse('2026-09-30T14:00:00Z')
    }]);
  });

  it('reports the description of a ticket created since then', () => {
    const found = mentionsIn([issue], ME, Date.parse('2026-09-01T09:00:00Z'), browse);
    expect(found.map((m) => m.where)).toEqual(['description', '99', '100']);
  });
});

const ticket = (key: string, updated = '2026-09-02T00:00:00Z'): JiraIssue => ({
  key, summary: `Ticket ${key}`, description: '', status: 'To Do', statusCategory: 'new',
  issueType: 'Task', updated, url: `https://jira.example/browse/${key}`, subtasks: [], comments: [], links: []
} as unknown as JiraIssue);

const said = (where: string): JiraMention => ({
  key: 'A-1', summary: 'Ticket A-1', url: 'u', where, who: 'Giovanni', excerpt: '@Idris look', at: 1
});

describe('diffActivity for Jira (item 119)', () => {
  it('reads the first mentions as the baseline, then reports new ones once', () => {
    const base = diffActivity({}, { jira: { tickets: [], mentions: [said('1')] } }, 1);
    expect(base.events).toEqual([]);
    const next = diffActivity(base.seen, { jira: { tickets: [], mentions: [said('1'), said('2')] } }, 2);
    expect(next.events).toMatchObject([{ kind: 'mentioned', id: 'mentioned:A-1:2', who: 'Giovanni', excerpt: '@Idris look', subject: 'A-1' }]);
    const again = diffActivity(next.seen, { jira: { tickets: [], mentions: [said('2')] } }, 3);
    expect(again.events).toEqual([]);
  });

  it('keeps what was reported when a refresh did not check mentions', () => {
    const base = diffActivity({}, { jira: { tickets: [], mentions: [] } }, 1);
    const skipped = diffActivity(base.seen, { jira: { tickets: [] } }, 2);
    expect(skipped.seen.jira?.mentions).toEqual([]);
  });

  it('says who assigned a ticket, and reports it again when it comes back', () => {
    const base = diffActivity({}, { jira: { tickets: [] } }, 1);
    const one = diffActivity(base.seen, { jira: { tickets: [ticket('A-2')], assignedBy: { 'A-2': 'Giovanni' } } }, 2);
    expect(one.events).toMatchObject([{ kind: 'new-ticket', subject: 'A-2', who: 'Giovanni' }]);
    const gone = diffActivity(one.seen, { jira: { tickets: [] } }, 3);
    const back = diffActivity(gone.seen, { jira: { tickets: [ticket('A-2', '2026-09-30T10:00:00Z')] } }, 4);
    expect(back.events[0]!.id).not.toBe(one.events[0]!.id);
  });
});
