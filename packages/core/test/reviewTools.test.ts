import { describe, expect, it } from 'vitest';
import {
  agentFamily, agentReviewArgs, foundPlantedBug, normaliseReviewTools, parseReviewToolModel, pullReviewPrompt,
  reviewFileName, reviewToolCommandLine, reviewToolId, reviewToolLabel, reviewToolModel, reviewToolVia
} from '../src';

describe('reviewers (item 143)', () => {
  it('keeps the model string nv-review always used', () => {
    expect(parseReviewToolModel('moonshotai/kimi-k3 (nv-review)')).toEqual({ id: 'nv-review', model: 'moonshotai/kimi-k3' });
    expect(reviewToolLabel('moonshotai/kimi-k3 (nv-review)')).toBe('Kimi K3');
    expect(reviewFileName('moonshotai/kimi-k3 (nv-review)')).toBe('kimi-k3-review.md');
    expect(reviewToolVia('moonshotai/kimi-k3 (nv-review)')).toBe('nv-review');
  });

  it('names other reviewers by id and model', () => {
    expect(reviewToolModel('claude', 'sonnet')).toBe('sonnet (claude)');
    expect(reviewToolModel('gemini-review')).toBe('(gemini-review)');
    expect(parseReviewToolModel('(gemini-review)')).toEqual({ id: 'gemini-review', model: undefined });
    expect(reviewToolLabel('sonnet (claude)')).toBe('claude · sonnet');
    expect(reviewFileName('sonnet (claude)')).toBe('claude-sonnet-review.md');
    expect(reviewToolVia('opencode/big-pickle')).toBe('opencode');
    expect(parseReviewToolModel('opencode/big-pickle')).toBeUndefined();
  });

  it('knows which commands are agents it can drive', () => {
    expect(agentFamily('claude')).toBe('claude');
    expect(agentFamily('claude-personal')).toBe('claude');
    expect(agentFamily('codex')).toBe('codex');
    expect(agentFamily('cc-review')).toBeUndefined();
    expect(agentFamily('claudette')).toBeUndefined();
  });

  it('runs agents read-only', () => {
    const claude = agentReviewArgs('claude', 'sonnet', '/tmp/out');
    expect(claude).toContain('--print');
    expect(claude.slice(claude.indexOf('--permission-mode'), claude.indexOf('--permission-mode') + 2)).toEqual(['--permission-mode', 'dontAsk']);
    expect(claude.slice(claude.indexOf('--allowedTools') + 1)).toEqual(['Read', 'Grep', 'Glob']);
    const codex = agentReviewArgs('codex', undefined, '/tmp/out');
    expect(codex.slice(0, 3)).toEqual(['exec', '--sandbox', 'read-only']);
    expect(codex).not.toContain('--model');
    expect(codex[codex.length - 1]).toBe('-');
    expect(reviewToolCommandLine({ kind: 'command', command: 'gemini-review', model: 'gemini-3-pro', modelEnv: 'GEMINI_MODEL' }))
      .toBe('GEMINI_MODEL=gemini-3-pro gemini-review < prompt');
  });

  it('always lists nv-review first and drops broken entries', () => {
    const tools = normaliseReviewTools([
      { id: 'claude', kind: 'agent', command: 'claude', model: 'sonnet', timeoutMinutes: 15 },
      { id: 'bad', kind: 'agent', command: 'cc-review' },
      { id: 'evil', kind: 'command', command: 'rm -rf ~' },
      { id: 'gemini-review', kind: 'command', command: 'gemini-review', modelEnv: 'NOT VALID' },
      null
    ], 'nvidia/nemotron');
    expect(tools.map((t) => t.id)).toEqual(['nv-review', 'claude', 'gemini-review']);
    expect(tools[0]).toMatchObject({ command: 'nv-review', modelEnv: 'NV_MODEL', model: 'nvidia/nemotron' });
    expect(tools[1]).toMatchObject({ family: 'claude', timeoutMinutes: 15 });
    expect(tools[2]!.modelEnv).toBeUndefined();
    expect(reviewToolId('claude', ['nv-review', 'claude'])).toBe('claude-2');
  });

  it('spots the planted bug in a test review', () => {
    expect(foundPlantedBug('`src/cart.ts:5` — `i <= items.length` reads one past the end.')).toBe(true);
    expect(foundPlantedBug('Off-by-one in the loop.')).toBe(true);
    expect(foundPlantedBug('Looks good to me.')).toBe(false);
  });

  it('tells an agent it may read the checkout', () => {
    const pull = { repo: 'a/b', number: 1, title: 't', author: 'x', headRef: 'h', baseRef: 'main', body: '', threads: [] };
    expect(pullReviewPrompt(pull as never, 'diff', { checkout: true })).toContain('read-only checkout');
    expect(pullReviewPrompt(pull as never, 'diff')).toContain('You have no tools');
  });
});
