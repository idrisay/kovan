import { describe, expect, it } from 'vitest';
import { verdictFrom } from '../src/runs';

describe('verdictFrom', () => {
  it("reads the prompt's four verdicts", () => {
    expect(verdictFrom('VERDICT: implemented\n\nChecked PR …')).toBe('implemented');
    expect(verdictFrom('VERDICT: partly implemented')).toBe('partly');
    expect(verdictFrom('VERDICT: not implemented')).toBe('not-implemented');
    expect(verdictFrom('VERDICT: could not check')).toBe('unchecked');
  });

  it('still reads old reports, and nothing else', () => {
    expect(verdictFrom('Verdict: shipped')).toBe('implemented');
    expect(verdictFrom('Verdict: broken')).toBe('not-implemented');
    expect(verdictFrom('\nVERDICT: implemented')).toBe('implemented');
    expect(verdictFrom('Some prose first')).toBe('unknown');
  });
});
