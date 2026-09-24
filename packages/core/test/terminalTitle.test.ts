import { describe, expect, it } from 'vitest';
import { usefulTerminalTitle } from '../src/terminalTitle';

describe('usefulTerminalTitle', () => {
  it('keeps a task title and drops the spinner in front', () => {
    expect(usefulTerminalTitle('✳ Investigate ACME-2409')).toBe('Investigate ACME-2409');
    expect(usefulTerminalTitle('⠐ Fix tooltip clamping')).toBe('Fix tooltip clamping');
  });

  it('drops titles that name the tool, not the work', () => {
    expect(usefulTerminalTitle('✳ Claude Code')).toBeUndefined();
    expect(usefulTerminalTitle('codex')).toBeUndefined();
  });

  it("drops a shell's own titles", () => {
    expect(usefulTerminalTitle('idrisay@mac: ~/code/web')).toBeUndefined();
    expect(usefulTerminalTitle('~/code/web')).toBeUndefined();
    expect(usefulTerminalTitle('npm')).toBeUndefined();
    expect(usefulTerminalTitle('   ')).toBeUndefined();
  });

  it('caps a long title', () => {
    const title = usefulTerminalTitle(`Refactor ${'x'.repeat(200)}`)!;
    expect(title.length).toBe(80);
    expect(title.endsWith('…')).toBe(true);
  });
});
