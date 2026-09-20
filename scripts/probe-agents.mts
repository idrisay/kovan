#!/usr/bin/env node
/**
 * "Can you find my agents?" — the data path, checked without an app around it.
 * The counterpart to devhub-mac's `devhub-probe`.
 */
import { available, resolve, shellLine } from '../packages/agent/src/index.ts';

const runners = await available();
console.log(`found ${runners.length} runners\n`);
for (const runner of runners) {
  const resolved = await resolve(runner, 'test prompt');
  const line = await shellLine(runner, 'test prompt');
  console.log(`  ${runner.name.padEnd(22)} ${runner.invocation.padEnd(14)} ${resolved ? resolved.executable : '— not resolvable'}`);
  if (line) console.log(`  ${''.padEnd(22)} ${line.slice(0, 96)}`);
}
