/**
 * Whether a link may be handed to the OS to open (security review, 2026-10).
 *
 * `shell.openExternal` opens whatever the scheme names: `file:///…/X.app` or a
 * `.command` file launches it, and a custom scheme starts whichever app
 * registered it. Links in Kovan come from other people (pull requests, CI
 * checks, tickets, Sentry), so only the web and mail are let through.
 */
const ALLOWED = new Set(['https:', 'http:', 'mailto:']);

export function isExternalUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    return ALLOWED.has(new URL(url).protocol);
  } catch {
    return false;
  }
}
