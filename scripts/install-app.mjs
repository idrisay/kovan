#!/usr/bin/env node
/**
 * Installs the built Baton.app into /Applications.
 *
 * Replaces any existing copy, but quits the running one first: swapping the
 * bundle under a live process leaves it running from a deleted inode, so it
 * keeps its old code until something restarts it — which looks exactly like
 * "my change did nothing".
 */

import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const built = path.join(root, 'apps/desktop/release/mac-arm64/Baton.app');
const target = '/Applications/Baton.app';

if (!fs.existsSync(built)) {
  console.error(`No build at ${built}\nRun: npm run dist --workspace @baton/desktop`);
  process.exit(1);
}

// Any copy, not just /Applications': one launched from the build folder holds
// the single-instance lock just the same, and would stop the new one starting.
const APP = 'Baton\\.app/Contents/MacOS/Baton$';

function running() {
  try {
    execFileSync('pgrep', ['-f', APP], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Asks the running copy to quit, then checks that it did. It may not: with
 * terminal sessions running, Baton asks "Quit Baton and stop N running
 * sessions?" and stays if you say Cancel. This used to print "stopped" as soon
 * as the signal was sent, then replace the bundle under the live app — the
 * very thing the note above warns about. It is never force-killed: that would
 * end your terminals and whatever agents are running in them.
 */
function quitRunning() {
  if (!running()) return;
  execFileSync('pkill', ['-f', APP], { stdio: 'ignore' });
  const deadline = Date.now() + 15_000;
  while (running() && Date.now() < deadline) {
    execFileSync('sleep', ['0.5']);
  }
  if (running()) {
    console.error(
      'Baton is still running — probably asking whether to stop its running sessions.\n' +
      'Nothing was installed. Quit it yourself (answer that dialog, or ⌘Q), then run this again.'
    );
    process.exit(1);
  }
  console.log('stopped the running Baton');
}

quitRunning();

if (fs.existsSync(target)) {
  fs.rmSync(target, { recursive: true, force: true });
  console.log('removed the previous /Applications/Baton.app');
}

fs.cpSync(built, target, { recursive: true, verbatimSymlinks: true });
console.log(`installed ${target}`);

// Ad-hoc signatures do not survive a copy intact on every macOS version, and an
// invalid one is refused at launch with a message that says nothing useful.
// Re-signing here costs a second and removes that whole class of confusion.
//
// Retried: right after the copy it once failed ("code has no resources but
// signature indicates they must be present") and then worked by hand a moment
// later. Launching an unverified bundle made macOS start the build folder's
// copy instead — same app id — which then held the single-instance lock, so
// the installed one could never start.
function sign() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      execFileSync('codesign', ['--force', '--deep', '--sign', '-', target], { stdio: 'pipe' });
      execFileSync('codesign', ['--verify', '--deep', target], { stdio: 'pipe' });
      return true;
    } catch (err) {
      if (attempt === 3) {
        console.error(`codesign failed: ${String(err.stderr ?? err.message).trim()}`);
        return false;
      }
      execFileSync('sleep', ['1']);
    }
  }
  return false;
}

if (!sign()) {
  console.error('Not launching an unsigned Baton. Check with:');
  console.error(`  codesign --verify --verbose ${target}`);
  process.exit(1);
}
console.log('re-signed and verified (ad-hoc)');

if (!process.argv.includes('--no-launch')) {
  spawn('open', ['-a', target], { detached: true, stdio: 'ignore' }).unref();
  // Say which copy actually started, not just that one was asked to.
  const deadline = Date.now() + 15_000;
  let path = '';
  while (!path && Date.now() < deadline) {
    execFileSync('sleep', ['0.5']);
    try {
      path = execFileSync('pgrep', ['-fl', 'Baton.app/Contents/MacOS/Baton$'], { encoding: 'utf8' }).trim();
    } catch {
      path = '';
    }
  }
  if (path.includes(`${target}/Contents/MacOS/Baton`)) {
    console.log('launched — Baton is in the Dock and Cmd+Tab');
  } else if (path) {
    console.warn(`A different copy of Baton is running:\n  ${path}\nQuit it, then open ${target}.`);
  } else {
    console.warn(`Baton didn't start. Open ${target} yourself, or check ~/Library/Logs/Baton/baton.log.`);
  }
}
