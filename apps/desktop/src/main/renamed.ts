/**
 * Carries the user's state across from Baton, the app's name until
 * 2026-09-30.
 *
 * The rename moves `userData` from "Baton" to "Kovan", and with it the
 * Keychain item `safeStorage` encrypts with ("Baton Safe Storage" becomes
 * "Kovan Safe Storage"). Without this, Kovan would start with no settings,
 * no run history and every token unreadable.
 *
 * Copied, never moved: the Baton folder stays as it was, so going back to
 * Baton.app loses nothing, and a failed copy leaves nothing half-moved.
 */

import { app, safeStorage } from 'electron';
import { execFile } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { cpSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { Logger } from '@kovan/host';

const OLD_NAME = 'Baton';
const MARKER = 'renamed-from-baton.json';
/** Written once the copy is done, so it never runs twice. */
const COPIED = 'copied-from-baton.json';

/** Rebuilt on launch, or only a cache: not worth copying. */
const SKIPPED = new Set([
  'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'Shared Dictionary', 'blob_storage', 'bin', 'status', 'SingletonLock', 'SingletonSocket', 'SingletonCookie'
]);

/**
 * Copies Baton's folder into Kovan's on the first launch. Synchronous and
 * before anything reads `userData`, the same way `setName` is.
 */
export function copyBatonState(): void {
  const target = app.getPath('userData');
  const source = path.join(app.getPath('appData'), OLD_NAME);
  // Not "Kovan's folder is missing": Electron creates it at startup, before
  // this runs. A fresh folder has no settings and no record of a copy.
  if (!existsSync(source) || existsSync(path.join(target, 'settings.json')) || existsSync(path.join(target, COPIED))) {
    return;
  }
  for (const entry of readdirSync(source)) {
    if (SKIPPED.has(entry)) continue;
    // What Electron has just created (an empty Local Storage) gives way to
    // Baton's whole item, never merged file by file with it.
    rmSync(path.join(target, entry), { recursive: true, force: true });
    cpSync(path.join(source, entry), path.join(target, entry), { recursive: true });
  }
  writeFileSync(path.join(target, COPIED), JSON.stringify({ from: source, at: new Date().toISOString() }));
  if (existsSync(path.join(target, 'secrets.json'))) {
    writeFileSync(path.join(target, MARKER), JSON.stringify({ at: new Date().toISOString(), secrets: 'pending' }));
  }
}

/**
 * Re-encrypts the copied `secrets.json` under Kovan's key. Needs `safeStorage`,
 * so it runs after `ready`, before anything reads a token.
 *
 * Tried once: macOS asks the user to allow reading "Baton Safe Storage", and
 * asking again on every launch after a "Deny" would be nagging. If it fails,
 * the providers show "not connected" and the user connects them again.
 */
export async function adoptBatonSecrets(log: Logger): Promise<void> {
  const dir = app.getPath('userData');
  const marker = path.join(dir, MARKER);
  if (!existsSync(marker)) {
    return;
  }
  const file = path.join(dir, 'secrets.json');
  try {
    const raw = await fs.readFile(file);
    if (!safeStorage.isEncryptionAvailable() || !raw.subarray(0, 3).equals(Buffer.from('v10'))) {
      return;
    }
    const { stdout } = await promisify(execFile)('security', [
      'find-generic-password', '-w', '-s', `${OLD_NAME} Safe Storage`, '-a', `${OLD_NAME} Key`
    ]);
    const json = decryptChromium(raw, stdout.trim());
    JSON.parse(json);
    await fs.writeFile(file, safeStorage.encryptString(json), { mode: 0o600 });
    log.info('Moved the saved tokens across from Baton');
  } catch (err) {
    log.warn('Could not move the saved tokens across from Baton; connect the providers again', err);
  } finally {
    await fs.rm(marker, { force: true });
  }
}

/**
 * Chromium's macOS `os_crypt` format, which `safeStorage` writes: "v10", then
 * AES-128-CBC keyed by PBKDF2-SHA1 of the Keychain password.
 */
function decryptChromium(raw: Buffer, password: string): string {
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  return Buffer.concat([decipher.update(raw.subarray(3)), decipher.final()]).toString('utf8');
}
