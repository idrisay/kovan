import { describe, expect, it } from 'vitest';
import { copyName, filterQuickCommands, normalizeQuickCommands, validateQuickCommand, type QuickCommand } from '../src';

const dev: QuickCommand = { id: 'a', name: 'frontend dev', command: 'cd ~/app/frontend && npm run dev', cwd: '' };
const opt: QuickCommand = { id: 'b', name: 'optimize', command: 'cd ~/tests && npm run optimize', cwd: '/Users/me' };
const tests: QuickCommand = { id: 'c', name: 'backend tests', command: 'pytest -x', cwd: '' };

describe('validateQuickCommand', () => {
  it('accepts a named command and trims it', () => {
    expect(validateQuickCommand({ name: ' frontend dev ', command: ' npm run dev ', cwd: '' }))
      .toEqual({ ok: true, value: { name: 'frontend dev', command: 'npm run dev', cwd: '' } });
  });

  it('says what is missing, in words', () => {
    expect(validateQuickCommand({ name: '', command: 'x' })).toMatchObject({ ok: false, error: 'Give it a name.' });
    expect(validateQuickCommand({ name: 'x', command: '  ' })).toMatchObject({ ok: false, error: 'Type the command to run.' });
    expect(validateQuickCommand({ name: 'x', command: 'y', cwd: 'relative/dir' })).toMatchObject({ ok: false });
  });

  it('allows a full or home-relative folder', () => {
    expect(validateQuickCommand({ name: 'x', command: 'y', cwd: '~/app' }).ok).toBe(true);
    expect(validateQuickCommand({ name: 'x', command: 'y', cwd: '/Users/me/app' }).ok).toBe(true);
  });
});

describe('normalizeQuickCommands', () => {
  it('keeps valid ones, drops junk and duplicate ids', () => {
    expect(normalizeQuickCommands([dev, { id: 'a', name: 'again', command: 'x' }, { name: 'no id', command: 'x' }, 7, null, opt]))
      .toEqual([dev, opt]);
    expect(normalizeQuickCommands('nope')).toEqual([]);
  });
});

describe('filterQuickCommands', () => {
  const list = [dev, opt, tests];
  it('returns everything for an empty search', () => {
    expect(filterQuickCommands(list, '  ')).toEqual(list);
  });
  it('matches names first, then commands', () => {
    // "dev" is in dev's name; "npm" only in commands.
    expect(filterQuickCommands(list, 'dev').map((c) => c.id)).toEqual(['a']);
    expect(filterQuickCommands(list, 'npm').map((c) => c.id)).toEqual(['a', 'b']);
    expect(filterQuickCommands(list, 'tests').map((c) => c.id)).toEqual(['c', 'b']);
  });
  it('needs every word', () => {
    expect(filterQuickCommands(list, 'npm optimize').map((c) => c.id)).toEqual(['b']);
  });
});

describe('copyName', () => {
  it('numbers copies without stacking "(copy)"', () => {
    expect(copyName('frontend dev', [])).toBe('frontend dev (copy)');
    expect(copyName('frontend dev', ['frontend dev (copy)'])).toBe('frontend dev (copy 2)');
    expect(copyName('frontend dev (copy)', ['frontend dev (copy)'])).toBe('frontend dev (copy 2)');
  });
});
