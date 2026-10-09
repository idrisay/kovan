import { describe, expect, it, vi } from 'vitest';

// The module builds its DOMPurify instance from `window`; the helpers don't need it.
vi.mock('dompurify', () => ({ default: () => ({ addHook: () => undefined, sanitize: (s: string) => s }) }));
vi.stubGlobal('window', {});
const { resolveLocal, slug } = await import('../src/renderer/MarkdownPreview');

describe('resolveLocal', () => {
  it('resolves against the file\'s folder', () => {
    expect(resolveLocal('/x/notes/report.md', 'images/a.png')).toBe('/x/notes/images/a.png');
    expect(resolveLocal('/x/notes/report.md', './images/a.png')).toBe('/x/notes/images/a.png');
    expect(resolveLocal('/x/notes/report.md', '../README.md')).toBe('/x/README.md');
  });

  it('decodes spaces and drops a query or anchor', () => {
    expect(resolveLocal('/x/r.md', 'my%20shot.png?raw=1')).toBe('/x/my shot.png');
    expect(resolveLocal('/x/r.md', 'other.md#setup')).toBe('/x/other.md');
  });

  it('keeps an absolute path', () => {
    expect(resolveLocal('/x/r.md', '/tmp/a.png')).toBe('/tmp/a.png');
  });
});

describe('slug', () => {
  it('makes GitHub-style anchors', () => {
    expect(slug('1. Status at a glance')).toBe('1-status-at-a-glance');
    expect(slug('White-label workspaces (ACME-2469): report')).toBe('white-label-workspaces-acme-2469-report');
  });
});
