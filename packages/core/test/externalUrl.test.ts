import { describe, expect, it } from 'vitest';
import { isExternalUrl } from '../src/externalUrl';

describe('isExternalUrl', () => {
  it('lets the web and mail through', () => {
    expect(isExternalUrl('https://github.com/acme/web/pull/1')).toBe(true);
    expect(isExternalUrl('http://localhost:3000/')).toBe(true);
    expect(isExternalUrl('mailto:someone@example.com')).toBe(true);
    expect(isExternalUrl('HTTPS://EXAMPLE.COM')).toBe(true);
  });

  it('refuses anything that could launch something', () => {
    expect(isExternalUrl('file:///Applications/Calculator.app')).toBe(false);
    expect(isExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isExternalUrl('vscode://file/etc/passwd')).toBe(false);
    expect(isExternalUrl('smb://evil.example/share')).toBe(false);
    expect(isExternalUrl('data:image/png;base64,AAAA')).toBe(false);
    expect(isExternalUrl('  file:///tmp/x.command')).toBe(false);
  });

  it('refuses what is not a URL at all', () => {
    expect(isExternalUrl('github.com/acme')).toBe(false);
    expect(isExternalUrl('')).toBe(false);
    expect(isExternalUrl(undefined)).toBe(false);
    expect(isExternalUrl({ toString: () => 'https://x' })).toBe(false);
  });
});
