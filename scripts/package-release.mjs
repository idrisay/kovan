#!/usr/bin/env node
/**
 * Packages a release someone else can install: `Kovan-<version>-arm64.dmg`
 * (drag Kovan into Applications), the same app as a `.zip`, and
 * `SHA256SUMS.txt`, all in `apps/desktop/release-<version>/`.
 *
 * Signed ad hoc, not with a Developer ID: there isn't one yet, so the app
 * can't be notarised, and macOS asks once before opening a downloaded copy
 * (System Settings › Privacy & Security › Open Anyway). The ad hoc signature
 * still matters: an Apple Silicon Mac won't run an unsigned app at all.
 *
 * electron-builder only produces the folder; the signature has to go on
 * before the disk image is made, which its own dmg target can't do with
 * `identity: null`. So this builds the folder, signs it, then makes the image.
 *
 * Run: `npm run release` (from the repository root).
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.join(root, 'apps/desktop');
const { version } = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
const out = path.join(desktop, `release-${version}`);
const app = path.join(out, 'mac-arm64/Kovan.app');
const name = `Kovan-${version}-arm64`;

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

fs.rmSync(out, { recursive: true, force: true });
run('npm', ['run', 'build'], { cwd: desktop });
run('npx', ['electron-builder', '--mac', '--arm64', `-c.directories.output=release-${version}`], { cwd: desktop });
run('codesign', ['--force', '--deep', '--sign', '-', app]);
run('codesign', ['--verify', '--deep', '--strict', app]);

// The disk image: the app and a link to /Applications, side by side.
const stage = path.join(out, 'dmg');
fs.mkdirSync(stage);
run('ditto', [app, path.join(stage, 'Kovan.app')]);
fs.symlinkSync('/Applications', path.join(stage, 'Applications'));
run('hdiutil', ['create', '-volname', `Kovan ${version}`, '-srcfolder', stage, '-format', 'UDZO', '-ov', path.join(out, `${name}.dmg`)]);
fs.rmSync(stage, { recursive: true });

// ditto keeps the signature and extended attributes a plain zip would lose.
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, path.join(out, `${name}.zip`)]);

const sums = execFileSync('shasum', ['-a', '256', `${name}.dmg`, `${name}.zip`], { cwd: out, encoding: 'utf8' });
fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), sums);
console.log(`\n${sums}\nWritten to ${out}`);
