import { describe, expect, it } from 'vitest';
import { parseRunPages, runPageUrl } from '../src';

const site = 'https://app.acme.test/en';

describe('run pages (item 109)', () => {
  const pages = '01-signed-in.png https://app.acme.test/en/dashboard\n52-student-b2c-unit-1617-preview.png https://app.acme.test/en/course/12/unit/1617?mode=preview\n';

  it('reads screenshot → address lines, ignoring anything else', () => {
    expect(parseRunPages(`${pages}garbage line\n`).get('01-signed-in.png')).toBe('https://app.acme.test/en/dashboard');
  });

  it("opens the page of the screenshot you're looking at", () => {
    expect(runPageUrl({ site, pages, shot: 'shots/52-student-b2c-unit-1617-preview.png' }))
      .toBe('https://app.acme.test/en/course/12/unit/1617?mode=preview');
  });

  it('falls back to the last recorded page, then to the report, then to the site', () => {
    expect(runPageUrl({ site, pages, shot: 'unknown.png' })).toContain('/unit/1617');
    expect(runPageUrl({ site, report: 'Checked https://app.acme.test/en/course/3/unit/9. Then https://github.com/x.' }))
      .toBe('https://app.acme.test/en/course/3/unit/9');
    expect(runPageUrl({ site, report: 'Nothing on the site.' })).toBe(site);
  });

  it('never opens an address on another host', () => {
    expect(runPageUrl({ site, pages: '01.png https://evil.example/phish\n', shot: '01.png' })).toBe(site);
  });
});

describe('older runs, from the report (item 109)', () => {
  const report = 'Signed in at https://app.acme.test/en, opened /course/215 then /course/215/unit/1617?mode=preview. Fix is in src/app/unit/page.tsx and /course/524.';
  it("picks the page matching the screenshot's numbered words", () => {
    expect(runPageUrl({ site, report, shot: '52-student-b2c-unit-1617-preview-link-stays-practice.png' }))
      .toBe('https://app.acme.test/en/course/215/unit/1617?mode=preview');
  });
  it('otherwise the last page the report mentions, never a source file', () => {
    expect(runPageUrl({ site, report })).toBe('https://app.acme.test/en/course/524');
  });
});
