/**
 * Where Kovan's Claude Code mod is (item 147): beside the app's other
 * resources when packaged, in the source tree when run from it. Undefined
 * when it isn't there, so a session starts as before rather than with a
 * `--plugin-dir` that points nowhere.
 */

import { app } from 'electron';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));

/** Where the pane's "Open in Kovan" requests land (item 148). */
export function claudeModOpenDir(): string {
  return path.join(app.getPath('userData'), 'open');
}

export function claudeModDir(): string | undefined {
  const dir = app.isPackaged
    ? path.join(process.resourcesPath, 'claude-mod', 'kovan')
    : path.join(dirname, '../../resources/claude-mod/kovan');
  return existsSync(path.join(dir, '.claude-plugin', 'plugin.json')) ? dir : undefined;
}
