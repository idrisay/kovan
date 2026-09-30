import { describe, expect, it } from 'vitest';
import { withoutInheritedClaudeSession } from '../src/shell';

describe('withoutInheritedClaudeSession', () => {
  it('drops the running Claude Code session out of a spawned agent\'s environment', () => {
    const env = {
      PATH: '/usr/bin:/bin',
      HOME: '/Users/idrisay',
      // What launching Kovan from inside a Claude Code session leaves behind.
      CLAUDE_CONFIG_DIR: '/Users/idrisay/.claude-admin',
      CLAUDE_CODE_SESSION_ID: 'abc123',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/1.sock',
      CLAUDECODE: '1',
      AI_AGENT: 'claude-code_2-1-278_agent'
    };

    const cleaned = withoutInheritedClaudeSession(env);

    expect(cleaned).toEqual({ PATH: '/usr/bin:/bin', HOME: '/Users/idrisay' });
  });

  it('leaves everything else untouched', () => {
    const env = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-not-claude-code-specific' };
    expect(withoutInheritedClaudeSession(env)).toEqual(env);
  });
});
