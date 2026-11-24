import { describe, expect, it } from 'vitest';
import {
  PROMPT_TEMPLATES, missingPlaceholders, placeholdersIn, previewPrompt, promptFingerprint, promptTemplate, unknownPlaceholders
} from '../src/promptTemplates';

describe('prompt templates (item 181)', () => {
  it('knows every placeholder each built-in prompt uses', () => {
    for (const t of PROMPT_TEMPLATES) {
      expect(unknownPlaceholders(t.kind, t.builtIn), t.kind).toEqual([]);
    }
  });

  it('fills every placeholder of each built-in prompt in the preview', () => {
    for (const t of PROMPT_TEMPLATES) {
      expect(previewPrompt(t.kind, t.builtIn), t.kind).not.toMatch(/\$\{\w+\}/);
    }
  });

  it('describes each placeholder once per kind', () => {
    for (const t of PROMPT_TEMPLATES) {
      const names = t.placeholders.map((p) => p.name);
      expect(new Set(names).size, t.kind).toBe(names.length);
    }
  });

  it('names a misspelled placeholder, which would reach the agent as literal text', () => {
    const text = 'Open it against ${base}. ${prReviewer}\n${report}';
    expect(unknownPlaceholders('implement', text)).toEqual(['prReviewer']);
    expect(previewPrompt('implement', text)).toContain('${prReviewer}');
  });

  it('flags a customised prompt that dropped the report rule', () => {
    expect(missingPlaceholders('implement', 'Just do ${url}.')).toEqual(['report']);
    expect(missingPlaceholders('implement', 'Do ${url}.\n${report}')).toEqual([]);
  });

  it('renders the shared values into the preview', () => {
    const text = promptTemplate('implement').builtIn;
    const preview = previewPrompt('implement', text, {
      baseBranch: 'develop', checks: ['npm run type-check'], untouchable: [], pullRequestReviewers: ['gidyb — Gidy', 'ledanni — Danni']
    });
    expect(preview).toContain('Request a review from gidyb — Gidy and ledanni — Danni on the pull request.');
    expect(preview).toContain('Open the pull request against develop');
    expect(preview).toContain('`npm run type-check`');
  });

  it('lists placeholders in order, once each', () => {
    expect(placeholdersIn('${a} ${b} ${a} $notone {c}')).toEqual(['a', 'b']);
  });

  it('fingerprints a text stably, and differently when it changes', () => {
    const t = promptTemplate('review').builtIn;
    expect(promptFingerprint(t)).toBe(promptFingerprint(t));
    expect(promptFingerprint(t)).not.toBe(promptFingerprint(`${t} `));
  });
});
