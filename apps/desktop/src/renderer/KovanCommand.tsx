/**
 * Settings › Text & terminal › "The kovan command" (item 178): installs the
 * script that makes `kovan <file>` work in any terminal, as VS Code's
 * "Install 'code' command in PATH" does. The state is read from main each
 * time the section opens, since the script can be removed from outside.
 */

import { useEffect, useState } from 'react';
import type { KovanCommandStatus } from '../main/kovanCommand';

export function KovanCommandSetting() {
  const [status, setStatus] = useState<KovanCommandStatus>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string }>();

  useEffect(() => { void window.kovan.cliStatus().then(setStatus); }, []);

  async function run(action: 'install' | 'remove') {
    setBusy(true);
    setResult(undefined);
    try {
      const done = await (action === 'install' ? window.kovan.cliInstall() : window.kovan.cliRemove());
      setStatus(done);
      setResult({ ok: !done.conflict && !done.unavailable && done.onPath !== false, text: done.message });
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  const state = !status ? 'Checking…'
    : status.installed
      ? status.stale ? `Installed at ${status.installed}, but it opens another copy of Kovan. Install again to point it here.`
        : status.onPath === false ? `Installed at ${status.installed}, which isn't on your PATH yet.`
          : `Installed at ${status.installed}.`
      : status.conflict ? `Another program called kovan is at ${status.conflict}. Kovan won't replace it.`
        : 'Not installed.';

  return (
    <>
      <h3>The kovan command</h3>
      <p className="settings-note">
        Open files and folders in Kovan from any terminal, as <code>code</code> does for VS Code:{' '}
        <code>kovan notes/improvements.md</code>, <code>kovan src/main.ts:42</code> for a line, <code>kovan .</code> for
        a folder. A file opens in the workspace that holds it; one in no workspace gets a workspace for its folder.
      </p>
      <p className={`settings-note${status?.installed && !status.stale && status.onPath !== false ? ' ok' : ''}`}>{state}</p>
      <div className="cli-actions">
        {!status?.unavailable && !status?.conflict && (
          <button type="button" className="ghost" disabled={busy || !status} onClick={() => void run('install')}>
            {status?.installed ? (status.stale ? 'Install again' : 'Reinstall') : "Install 'kovan' command"}
          </button>
        )}
        {status?.installed && (
          <button type="button" className="link" disabled={busy} onClick={() => void run('remove')}>Remove</button>
        )}
      </div>
      {status?.unavailable && <p className="settings-note error">{status.unavailable}</p>}
      {result && <p className={result.ok ? 'settings-note ok' : 'settings-note error'}>{result.text}</p>}
    </>
  );
}
