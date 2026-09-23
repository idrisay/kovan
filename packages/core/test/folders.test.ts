import { describe, expect, it } from 'vitest';
import { extraDirArgs, foldersPromptSection } from '../src/folders';

describe('extraDirArgs', () => {
  it('uses the = form for Claude Code and Codex, and nothing for others', () => {
    expect(extraDirArgs('claude-admin', ['/a b', '/c'])).toEqual(['--add-dir=/a b', '--add-dir=/c']);
    expect(extraDirArgs('codex', ['/c'])).toEqual(['--add-dir=/c']);
    expect(extraDirArgs('opencode', ['/c'])).toEqual([]);
  });
});

describe('foldersPromptSection', () => {
  it('is empty for one folder and names every extra one otherwise', () => {
    const main = { label: 'acme/web', path: '/src/web' };
    expect(foldersPromptSection(main, [])).toBe('');
    const text = foldersPromptSection(main, [{ label: 'acme/api', path: '/src/api' }]);
    expect(text).toContain('started in acme/web (/src/web)');
    expect(text).toContain('- acme/api — /src/api');
  });
});
