#!/usr/bin/env node
/**
 * Moves DevHub's state to Baton. Run once, before first launch.
 *
 *   node scripts/import-from-devhub.mjs [--dry-run]
 *
 * Three stores move:
 *
 *   1. Keychain tokens. The Swift app wrote one generic-password item per
 *      service under `com.idrisay.devhub.*`. Electron's `safeStorage` uses a
 *      different mechanism entirely, so without this step every provider
 *      reports "not connected" — which reads as a bug rather than as a
 *      migration step, so it is worth doing before the first launch.
 *
 *      Reading each item makes macOS decide whether this process may *see* the
 *      secret, so expect one authorisation dialog per service. That is the
 *      system working; approve them.
 *
 *   2. `defaults read com.idrisay.devhub` — the ~20 settings keys in
 *      devhub-mac/DOCS.md §13.
 *
 *   3. `~/Library/Application Support/DevHub/` — activity.json and the runs
 *      archive, copied verbatim. The run folders are deliberately NOT
 *      transformed: their layout is the contract the agent prompts write to.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DRY = process.argv.includes('--dry-run');
const OLD_DOMAIN = 'com.idrisay.devhub';
const OLD_SUPPORT = path.join(os.homedir(), 'Library/Application Support/DevHub');
const NEW_SUPPORT = path.join(os.homedir(), 'Library/Application Support/Baton');

const SERVICES = ['github', 'jira'];

/** Settings whose names carry over unchanged, minus the `devhub.` prefix. */
const SETTING_KEYS = [
  'github.useCLI',
  'jira.site',
  'jira.email',
  'jira.jql',
  'repos.folders',
  'workspaces.list',
  'workspaces.active',
  'workspaces.scopeToFolders',
  'runner.default',
  'runner.custom',
  'runner.reviewers',
  'environments.list',
  'environments.last',
  'reviewer.custom',
  'prompt.conventions'
];

/** `jira.site` was the Swift name; the shared schema calls it `jira.baseUrl`. */
const RENAMES = { 'jira.site': 'jira.baseUrl' };

function say(...args) {
  console.log(...args);
}

function readDefault(key) {
  try {
    return execFileSync('defaults', ['read', OLD_DOMAIN, key], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Reads one of the Swift app's Keychain items.
 *
 * Note the query shape, which is easy to get backwards: `Keychain.swift` puts
 * the bare prefix in the *service* field and the per-provider name in the
 * *account* field, so this is `-s com.idrisay.devhub -a com.idrisay.devhub.jira`
 * and not the other way round. Searching by service alone finds the wrong item
 * or none.
 */
function readKeychain(service) {
  try {
    return execFileSync(
      'security',
      ['find-generic-password', '-s', OLD_DOMAIN, '-a', `${OLD_DOMAIN}.${service}`, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
  } catch {
    return undefined;
  }
}

/**
 * GitHub's token may not be in the Keychain at all.
 *
 * `github.useCLI` means the Swift app shelled out to `gh auth token` instead of
 * storing one, so there is nothing to migrate — the CLI already holds it. Baton
 * reads it the same way, which is also why this returns it rather than
 * prompting for a new personal access token.
 */
function readGhCli() {
  try {
    return execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return undefined;
  }
}

/** `defaults` prints plist syntax, not JSON. Enough of it to read a list. */
function parsePlistish(raw) {
  if (raw === undefined) return undefined;
  if (raw === '1') return true;
  if (raw === '0') return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (raw.startsWith('(')) {
    return raw
      .slice(1, -1)
      .split('\n')
      .map((line) => line.trim().replace(/,$/, '').replace(/^"|"$/g, ''))
      .filter(Boolean);
  }
  return raw;
}

// --- 1. Settings -------------------------------------------------------------

const settings = {};
for (const key of SETTING_KEYS) {
  const value = parsePlistish(readDefault(key));
  if (value !== undefined && value !== '') {
    settings[RENAMES[key] ?? key] = value;
  }
}
say(`settings: found ${Object.keys(settings).length} of ${SETTING_KEYS.length} keys`);

// `workspaces.scopeToFolders` was a tri-state: unset meant "never answered".
// The new schema makes that explicit as a mode.
if ('workspaces.scopeToFolders' in settings) {
  settings['scope.mode'] = settings['workspaces.scopeToFolders'] ? 'folders' : 'all';
  delete settings['workspaces.scopeToFolders'];
}

// --- 2. Support files --------------------------------------------------------

const copied = [];
if (fs.existsSync(OLD_SUPPORT)) {
  for (const entry of ['activity.json', 'runs']) {
    const from = path.join(OLD_SUPPORT, entry);
    if (!fs.existsSync(from)) continue;
    const to = path.join(NEW_SUPPORT, entry);
    if (!DRY) {
      fs.mkdirSync(NEW_SUPPORT, { recursive: true });
      fs.cpSync(from, to, { recursive: true });
    }
    copied.push(entry);
  }
}
say(`support files: ${copied.length > 0 ? copied.join(', ') : 'none found'}`);

// --- 3. Tokens ---------------------------------------------------------------

const tokens = {};
for (const service of SERVICES) {
  say(`keychain: reading ${OLD_DOMAIN}.${service} (approve the dialog if one appears)…`);
  let value = readKeychain(service);
  if (!value && service === 'github' && settings['github.useCLI']) {
    say('  no item stored — github.useCLI is set, reading `gh auth token` instead');
    value = readGhCli();
  }
  if (value) {
    tokens[service] = value;
  } else {
    say(`  not found; you will need to connect ${service} in the app`);
  }
}
say(`tokens: recovered ${Object.keys(tokens).length} of ${SERVICES.length}`);

// --- Write -------------------------------------------------------------------

if (DRY) {
  say('\n--dry-run: nothing written.');
  say(JSON.stringify({ settings, tokens: Object.keys(tokens), copied }, null, 2));
  process.exit(0);
}

fs.mkdirSync(NEW_SUPPORT, { recursive: true });
fs.writeFileSync(path.join(NEW_SUPPORT, 'settings.json'), JSON.stringify(settings, null, 2));

/**
 * Tokens land in a staging file rather than `secrets.json`.
 *
 * `safeStorage` can only encrypt inside a running Electron app — this is a
 * plain Node script and has no access to the app's OS key — so the app picks
 * this file up on next launch, encrypts it, and deletes it. It is written 0600
 * and is short-lived, but it IS plaintext until that happens, which is why the
 * app does the pickup first thing rather than lazily.
 */
if (Object.keys(tokens).length > 0) {
  fs.writeFileSync(path.join(NEW_SUPPORT, 'import-tokens.json'), JSON.stringify(tokens), {
    mode: 0o600
  });
}

say(`\nWritten to ${NEW_SUPPORT}`);
say('Launch Baton; it will encrypt the staged tokens and remove the staging file.');
