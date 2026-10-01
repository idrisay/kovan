/**
 * The one way the main process opens a link in the OS (security review,
 * 2026-10). The renderer's own checks are a courtesy; this is the one that
 * decides, so a link from a CI check, a ticket or a compromised window cannot
 * open `file:` or a custom scheme. See `isExternalUrl`.
 */

import { shell } from 'electron';
import { isExternalUrl } from '@kovan/core';

export async function openLink(url: unknown, warn?: (message: string) => void): Promise<void> {
  if (!isExternalUrl(url)) {
    warn?.(`Did not open a link that is not http(s) or mailto: ${String(url).slice(0, 80)}`);
    return;
  }
  await shell.openExternal(url);
}
