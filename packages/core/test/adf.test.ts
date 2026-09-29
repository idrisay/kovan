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

describe('emoji (item 102)', () => {
  const doc = (attrs: Record<string, unknown>) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'emoji', attrs }, { type: 'text', text: ' Flag added' }] }] });
  it("shows Jira's own flag emoji, which comes with only a short name", () => {
    expect(adfToMarkdown(doc({ shortName: ':flag_on:', id: 'atlassian-flag_on', text: ':flag_on:' }))).toBe('🚩 Flag added');
    expect(adfToMarkdown(doc({ shortName: ':flag_on:' }))).toBe('🚩 Flag added');
  });
  it('keeps a real character, and an unknown short name as written', () => {
    expect(adfToMarkdown(doc({ shortName: ':grinning:', text: '😀' }))).toBe('😀 Flag added');
    expect(adfToMarkdown(doc({ shortName: ':company-logo:' }))).toBe(':company-logo: Flag added');
  });
});
