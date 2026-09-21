import { describe, expect, it } from 'vitest';
import { JiraClient } from '../src/jira/JiraClient';
import type { HttpClient } from '../src/http';

const PNG_BYTES = Uint8Array.from([1, 2, 3, 4]);

/** Just enough of `HttpClient` for `JiraClient` to run against, no network. */
function fakeHttp(issue: unknown): HttpClient {
  return {
    json: async () => issue,
    binary: async () => ({ bytes: PNG_BYTES, contentType: 'image/png' })
  } as unknown as HttpClient;
}

const rawIssue = {
  key: 'ACME-1',
  fields: {
    summary: 'Fix the thing',
    description: {
      type: 'doc',
      content: [
        {
          type: 'mediaSingle',
          content: [{ type: 'media', attrs: { id: 'm1', type: 'file', alt: 'shot.png' } }]
        }
      ]
    },
    status: { name: 'Open', statusCategory: { key: 'new' } },
    issuetype: { name: 'Bug' },
    updated: '2026-01-01T00:00:00.000Z',
    attachment: [
      { id: '10001', filename: 'shot.png', content: 'https://site.atlassian.net/rest/api/3/attachment/content/10001', mimeType: 'image/png' }
    ]
  }
};

describe('JiraClient.getIssue', () => {
  it('resolves an inline attachment to a real data-URI image', async () => {
    const client = new JiraClient(fakeHttp(rawIssue), 'https://site.atlassian.net', 'me@example.com', 'token');
    const issue = await client.getIssue('ACME-1');

    expect(issue.description).toBe(`![shot.png](data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')})`);
  });

  it('falls back to a plain-text note when the filename matches nothing in the attachment list', async () => {
    const noMatch = {
      ...rawIssue,
      fields: { ...rawIssue.fields, attachment: [] }
    };
    const client = new JiraClient(fakeHttp(noMatch), 'https://site.atlassian.net', 'me@example.com', 'token');
    const issue = await client.getIssue('ACME-1');

    expect(issue.description).toBe('_(attachment: shot.png)_');
  });
});
