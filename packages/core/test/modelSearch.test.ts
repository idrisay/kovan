import { describe, expect, it } from 'vitest';
import { modelFamily, parseModelSearch, parseOpencodeModels } from '../src/modelSearch';

describe('modelFamily', () => {
  it('knows a wrapper by the CLI it wraps', () => {
    expect(modelFamily('claude-admin')).toBe('claude');
    expect(modelFamily('codex')).toBe('codex');
    expect(modelFamily('aider')).toBeUndefined();
  });
});

describe('parseModelSearch', () => {
  it('reads the last list, dropping duplicates and anything that is not a model name', () => {
    const text = 'Found these:\n{"models":["opus","sonnet","opus","rm -rf /",42,"claude-opus-5-5"]}';
    expect(parseModelSearch(text)).toEqual({ models: ['opus', 'sonnet', 'claude-opus-5-5'] });
  });

  it('is an error when nothing usable came back', () => {
    expect('error' in parseModelSearch('{"models":[]}')).toBe(true);
    expect('error' in parseModelSearch('I could not search.')).toBe(true);
  });
});

describe('parseOpencodeModels', () => {
  it('keeps provider/model lines only', () => {
    expect(parseOpencodeModels('Loading…\nopencode/grok-code-fast\nanthropic/claude-sonnet-5\n\n')).toEqual([
      'opencode/grok-code-fast', 'anthropic/claude-sonnet-5'
    ]);
  });
});
