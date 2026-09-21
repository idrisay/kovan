import { describe, expect, it } from 'vitest';
import { JIRA_MEDIA_PATTERN, adfToMarkdown, jiraMediaToken } from '../src/jira/adf';

describe('adfToMarkdown', () => {
  it('renders an inline image with a filename as a resolvable media token', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'mediaSingle',
          content: [
            { type: 'media', attrs: { id: 'a1b2', type: 'file', alt: 'Screenshot 2026-09-01 at 13.20.47.png' } }
          ]
        }
      ]
    };

    const markdown = adfToMarkdown(doc);

    expect(markdown).toBe(jiraMediaToken('Screenshot 2026-09-01 at 13.20.47.png'));
    const [match] = [...markdown.matchAll(JIRA_MEDIA_PATTERN)];
    expect(match?.[1]).toBe('Screenshot 2026-09-01 at 13.20.47.png');
    expect(decodeURIComponent(match![2])).toBe('Screenshot 2026-09-01 at 13.20.47.png');
  });

  it('falls back to a plain-text note when there is no filename to correlate against', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'a1b2', type: 'file' } }] }]
    };

    expect(adfToMarkdown(doc)).toBe('_(attachment: a1b2)_');
    expect(adfToMarkdown(doc)).not.toMatch(JIRA_MEDIA_PATTERN);
  });
});
