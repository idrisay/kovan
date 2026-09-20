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

/**
 * The whole domain, as JSON.
 *
 * NOT `defaults read <key>`, which was the first version and was wrong in a way
 * that only showed up at runtime. Swift wrote `runner.custom` and
 * `prompt.conventions` as JSON-encoded `Data`, and `defaults read` renders that
 * as a hex dump — `{length = 147, bytes = 0x5b7b2269 …}` — which imported
 * cleanly as a *string* and then blew up the moment anything read `.length` on
 * it.
 *
 * `defaults export` plus `plutil -convert json` gives real types, with `Data`
 * base64-encoded, which `decodeBlob` below turns back into the JSON it is.
 */
function readDomain() {
  try {
    const xml = execFileSync('defaults', ['export', OLD_DOMAIN, '-'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 8 * 1024 * 1024
    });
    // Via python's plistlib rather than `plutil -convert json`, which refuses
    // outright on a plist containing `Data` — and `Data` is exactly what the
    // two interesting keys are. Base64 here, decoded by `decodeBlob`.
    const json = execFileSync(
      'python3',
      [
        '-c',
        'import plistlib,sys,json,base64\n' +
          'd=plistlib.loads(sys.stdin.buffer.read())\n' +
          'print(json.dumps({k:(base64.b64encode(v).decode() if isinstance(v,bytes) else v) for k,v in d.items()}, default=str))'
      ],
      { input: xml, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
    );
    return JSON.parse(json);
  } catch (err) {
    console.warn(`could not read ${OLD_DOMAIN}: ${err.message}`);
    return {};
  }
}

/**
 * A base64 `Data` value that is really JSON, or the value unchanged.
 *
 * Swift's `JSONEncoder` output stored in UserDefaults arrives here as base64.
 * Anything that does not decode to JSON is left alone rather than guessed at.
 */
function decodeBlob(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length < 8) {
    return value;
  }
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' ? parsed : value;
  } catch {
    return value;
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
// eslint-disable-next-line no-unused-vars
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

// --- 1. Settings -------------------------------------------------------------

const domain = readDomain();
const settings = {};
for (const key of SETTING_KEYS) {
  const value = decodeBlob(domain[key]);
  if (value !== undefined && value !== '') {
    settings[RENAMES[key] ?? key] = value;
  }
}

// `prompt.conventions` and `runner.custom` are the two that were Data blobs.
// Refuse to carry either across unless it decoded into the shape the app
// expects — a half-understood value is worse than an absent one, because the
// defaults are correct and a malformed one crashes the runner list.
if (settings['prompt.conventions'] && typeof settings['prompt.conventions'] !== 'object') {
  console.warn('prompt.conventions did not decode; leaving it at the default');
  delete settings['prompt.conventions'];
}
if (!Array.isArray(settings['runner.custom'])) {
  if (settings['runner.custom']) {
    console.warn('runner.custom did not decode; leaving it empty');
  }
  delete settings['runner.custom'];
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
