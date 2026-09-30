#!/usr/bin/env node
/**
 * Builds `kovan-dictate`, the dictation helper (improvements item 88), from
 * `native/dictate` into `resources/bin`, where dev runs find it and
 * electron-builder copies it from.
 *
 * Only when the source is newer than the binary, so every `build` and
 * `smoke` doesn't pay the ~7 s compile. Without `swiftc` (no Xcode command
 * line tools) it warns and carries on: Kovan works, dictation reports that
 * its helper is missing.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'native/dictate/main.swift');
const plist = path.join(root, 'native/dictate/Info.plist');
const out = path.join(root, 'resources/bin/kovan-dictate');

const newest = Math.max(statSync(source).mtimeMs, statSync(plist).mtimeMs, statSync(fileURLToPath(import.meta.url)).mtimeMs);
if (existsSync(out) && statSync(out).mtimeMs >= newest) {
  process.exit(0);
}

try {
  execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'ignore' });
} catch {
  console.warn('kovan-dictate: swiftc not found (install the Xcode command line tools); dictation will be unavailable.');
  process.exit(0);
}

mkdirSync(path.dirname(out), { recursive: true });
execFileSync(
  'xcrun',
  [
    'swiftc', '-O', '-o', out, source,
    // A command-line tool has no bundle; Speech and AVFoundation refuse to run
    // without usage descriptions, so they're embedded in the binary itself.
    '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', plist,
    '-suppress-warnings'
  ],
  { stdio: 'inherit' }
);
console.log(`built ${path.relative(root, out)}`);
