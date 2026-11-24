/**
 * Open at login on Linux. Electron's login-item API is macOS and Windows
 * only; the desktop standard is a `.desktop` file in `~/.config/autostart`.
 * It starts Kovan with `--hidden`, the Linux stand-in for macOS's
 * `wasOpenedAtLogin`: polling starts, no window jumps up.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export const HIDDEN_FLAG = '--hidden';

function entryPath(): string {
  const config = process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config');
  return path.join(config, 'autostart', 'kovan.desktop');
}

/** A path as one word of a desktop entry's Exec line. */
function execWord(file: string): string {
  return `"${file.replace(/(["`$\\])/g, '\\$1')}"`;
}

export async function setLinuxAutostart(on: boolean): Promise<void> {
  const file = entryPath();
  if (!on) {
    await rm(file, { force: true });
    return;
  }
  // An AppImage runs from a temporary mount; $APPIMAGE is the file itself.
  const binary = process.env['APPIMAGE'] || process.execPath;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Kovan',
    'Comment=What is blocked on you, handed to a coding agent',
    `Exec=${execWord(binary)} ${HIDDEN_FLAG}`,
    'X-GNOME-Autostart-enabled=true',
    'Terminal=false',
    ''
  ].join('\n'));
}
