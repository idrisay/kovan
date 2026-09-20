/**
 * Picks up the staging file `scripts/import-from-devhub.mjs` leaves behind.
 *
 * The importer is a plain Node script, so it cannot use `safeStorage` — that
 * needs a running Electron app holding the OS key. It therefore writes the
 * recovered tokens to `import-tokens.json` at 0600, and this runs first thing
 * on launch to encrypt them properly and delete the plaintext.
 *
 * Deleting is the point, so the unlink happens even when a token fails to
 * store: leaving plaintext credentials on disk indefinitely is worse than
 * asking the user to connect that provider by hand.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DesktopHost } from './host';

export async function adoptImportedTokens(host: DesktopHost): Promise<number> {
  const file = path.join(host.files.stateDir(), 'import-tokens.json');

  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return 0;
  }

  let adopted = 0;
  try {
    const tokens = JSON.parse(raw) as Record<string, string>;
    for (const [provider, value] of Object.entries(tokens)) {
      if (typeof value === 'string' && value.length > 0) {
        await host.secrets.set(provider, value);
        adopted++;
      }
    }
    host.log.info(`Adopted ${adopted} imported token(s) from DevHub`);
  } catch (err) {
    host.log.error('Could not adopt imported tokens', err);
  } finally {
    await fs.rm(file, { force: true });
  }

  return adopted;
}
