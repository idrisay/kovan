import { describe, expect, it } from 'vitest';
import { QUICK_OPENCODE_CONFIG, parseQuickOutput, quickArgs } from '../src/quick';

const line = (event: unknown) => JSON.stringify(event);

describe('quickArgs', () => {
  it('ends flags before the instruction, so it can never be read as one', () => {
    const args = quickArgs('opencode/m', '/tmp/x/input.md', '--help me');
    expect(args.slice(-2)).toEqual(['--', '--help me']);
    expect(args).toContain('/tmp/x/input.md');
  });

  it('asks rather than denies, so the free tier still accepts the request', () => {
    expect(JSON.parse(QUICK_OPENCODE_CONFIG).permission).toEqual({ '*': 'ask' });
  });
});

describe('parseQuickOutput', () => {
  it('takes the last text part, not the commentary before a rejected tool call', () => {
    const out = [
      line({ type: 'step_start' }),
      line({ type: 'text', part: { type: 'text', text: "I'll check the workspace first." } }),
      line({ type: 'tool_use', part: { type: 'tool', tool: 'read', state: { status: 'error', input: { filePath: '/tmp/x' } } } }),
      line({ type: 'step_finish', part: { tokens: { input: 100, output: 5, reasoning: 20 } } }),
      line({ type: 'text', part: { type: 'text', text: '- **CI failing** — lint\n' } }),
      line({ type: 'step_finish', part: { tokens: { input: 50, output: 30, reasoning: 0 } } })
    ].join('\n');
    expect(parseQuickOutput(out)).toEqual({
      text: '- **CI failing** — lint',
      tokens: { input: 150, output: 35, reasoning: 20 },
      refused: ['read /tmp/x']
    });
  });

  it('surfaces a provider error', () => {
    const out = line({ type: 'error', error: { name: 'APIError', data: { message: 'free tier refused' } } });
    expect(parseQuickOutput(out)).toEqual({ error: 'free tier refused', tokens: undefined, refused: [] });
  });

  it('ignores noise lines and reports an empty answer', () => {
    expect(parseQuickOutput('> build · model\nnot json\n').error).toMatch(/no answer/);
  });
});
