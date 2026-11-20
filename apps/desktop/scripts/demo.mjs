#!/usr/bin/env node
/**
 * `npm run demo` — Kovan with fake data, for recording videos.
 *
 * Builds the app into `release-demo/` (never `release/`, which the real app may
 * be running from), creates a few throwaway git repos under ~/kovan-demo so
 * agents and the explorer have something real to work in, and launches the
 * packaged app with KOVAN_SMOKE=demo against its own profile. Your real
 * profile, tokens and queues are never read.
 *
 *   npm run demo              build, then launch
 *   npm run demo -- --no-build   launch the last demo build
 *   npm run demo -- --fresh      also reset the demo profile and repos
 *
 * In the app: press Refresh once and pull request #118's checks fail — the
 * real "Blocked on you" notification fires (have the window closed or behind
 * another app to see the macOS one, in front for the in-app toast).
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const args = new Set(process.argv.slice(2));

const profile = path.join(homedir(), 'Library', 'Application Support', 'Kovan Demo');
const repos = path.join(homedir(), 'kovan-demo');
const binary = path.join(appDir, 'release-demo', 'mac-arm64', 'Kovan.app', 'Contents', 'MacOS', 'Kovan');

if (args.has('--fresh')) {
  rmSync(profile, { recursive: true, force: true });
  rmSync(repos, { recursive: true, force: true });
}

if (!args.has('--no-build')) {
  const run = (cmd, argv) => execFileSync(cmd, argv, { cwd: appDir, stdio: 'inherit' });
  run('node', ['scripts/build-dictate.mjs']);
  run('npx', ['electron-vite', 'build']);
  run('npx', ['electron-builder', '--dir', '--config.directories.output=release-demo']);
}
if (!existsSync(binary)) {
  console.error(`No demo build at ${binary}. Run without --no-build first.`);
  process.exit(1);
}

// --- Fake repositories -------------------------------------------------------

const git = (cwd, ...argv) => execFileSync('git', argv, { cwd, stdio: 'ignore' });

function seedRepo(name, files, branch) {
  const dir = path.join(repos, name);
  if (existsSync(path.join(dir, '.git'))) return;
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Demo');
  git(dir, 'config', 'user.email', 'demo@example.invalid');
  git(dir, 'remote', 'add', 'origin', `https://github.com/acme/${name}.git`);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Initial commit');
  if (branch) git(dir, 'checkout', '-q', '-b', branch);
}

seedRepo(
  'web',
  {
    'README.md': '# acme/web\n\nThe storefront.\n',
    'package.json': JSON.stringify({ name: '@acme/web', private: true, scripts: { test: 'node --test' } }, null, 2) + '\n',
    'checkout/summary.tsx': [
      "import { formatTotal } from './total';",
      '',
      'export function renderCheckoutSummary(checkout: { cart?: { total: number } }) {',
      '  // Throws when the cart has not loaded yet.',
      '  return `Total: ${formatTotal(checkout.cart.total)}`;',
      '}',
      ''
    ].join('\n'),
    'checkout/total.ts': "export const formatTotal = (n: number) => `CHF ${n.toFixed(2)}`;\n",
    'payments/retry.ts': [
      'export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {',
      '  for (let i = 0; ; i++) {',
      '    try {',
      '      return await fn();',
      '    } catch (err) {',
      '      if (i >= attempts) throw err;',
      '    }',
      '  }',
      '}',
      ''
    ].join('\n'),
    'src/components/QuestionTable.tsx': [
      'export function QuestionTable({ rows }: { rows: string[][] }) {',
      '  return (',
      '    <div className="overflow-x-auto">',
      '      <div className="min-w-full overflow-hidden">',
      '        {rows.map((r, i) => <div key={i}>{r.join(" · ")}</div>)}',
      '      </div>',
      '    </div>',
      '  );',
      '}',
      ''
    ].join('\n')
  },
  'fix/ACME-2393-tablet-mobile-qa-round2'
);

seedRepo('billing', {
  'README.md': '# acme/billing\n\nInvoices and the PDF generator.\n',
  'invoice/pdf.ts': 'export function renderInvoicePdf(id: string): Buffer {\n  return Buffer.from(`invoice ${id}`);\n}\n'
});

seedRepo('api', {
  'README.md': '# acme/api\n\nThe public API.\n',
  'src/health.ts': "export const health = () => ({ ok: true });\n"
});

// --- Launch ------------------------------------------------------------------

mkdirSync(profile, { recursive: true });
console.log(`Kovan demo: profile ${profile}, repos ${repos}`);
console.log('Press Refresh once in the app to make #118 blocked and fire the notification.');

spawn(binary, [], {
  stdio: 'inherit',
  env: {
    ...process.env,
    KOVAN_SMOKE: 'demo',
    KOVAN_USER_DATA: profile,
    KOVAN_WS_FOLDER: repos,
    KOVAN_WS_NAME: 'Acme'
  }
});
