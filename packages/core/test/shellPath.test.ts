import { describe, expect, it } from 'vitest';
import { shellPath } from '../src/shellPath';

describe('shellPath', () => {
  it('escapes spaces and shell punctuation', () => {
    expect(shellPath('/Users/me/Desktop/Screen Shot (1).png')).toBe('/Users/me/Desktop/Screen\\ Shot\\ \\(1\\).png');
    expect(shellPath("/tmp/it's.png")).toBe("/tmp/it\\'s.png");
  });

  it('leaves a plain path alone', () => {
    expect(shellPath('/tmp/baton-paste/pasted-2026.png')).toBe('/tmp/baton-paste/pasted-2026.png');
  });
});
