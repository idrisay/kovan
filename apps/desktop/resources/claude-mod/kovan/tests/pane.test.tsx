import { describe, expect, mock, test } from 'claude-code/testing'

import { checkName, cutAtHunk, modelName, resets, summarize, tokens, usageLine } from '../hooks/register'

const PANE = { component: 'Pane', requestId: 'kovan', props: { title: 'Kovan', isFocused: false, bodyColumns: 60, placement: 'dock' } } as never

describe('helpers', () => {
  test('names checks by what the command runs', async () => {
    expect(checkName('npm run typecheck')).toBe('Typecheck')
    expect(checkName('npx tsc --noEmit')).toBe('Typecheck')
    expect(checkName('npm test -- player')).toBe('Tests')
    expect(checkName('pytest -q')).toBe('Tests')
    expect(checkName('npx eslint src')).toBe('Lint')
    expect(checkName('git status')).toBeUndefined()
  })

  test('summarizes a run by its telling line', async () => {
    expect(summarize('...\n Tests  14 passed (14)\n Duration 2s\n')).toBe('Tests  14 passed (14)')
    expect(summarize('src/a.ts(42,3): error TS2339: nope\n')).toBe('src/a.ts(42,3): error TS2339: nope')
    expect(summarize('just this\n')).toBe('just this')
  })

  test('cuts a long diff where a hunk starts', async () => {
    const lines = ['diff --git a/x b/x', '@@ -1 +1 @@', '-a', '+b', '@@ -9 +9 @@', '-c', '+d']
    expect(cutAtHunk(lines, 5)).toEqual(lines.slice(0, 4))
    expect(cutAtHunk(lines, 10)).toEqual(lines)
  })

  test('writes the usage line', async () => {
    expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelName('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5')
    expect(tokens(402_000)).toBe('402k')
    expect(tokens(1_000_000)).toBe('1.0M')
    const now = new Date(2026, 9, 7, 13, 48).getTime()
    expect(resets(new Date(2026, 9, 7, 15, 40).toISOString(), now)).toBe('15:40')
    expect(resets(new Date(2026, 9, 12, 9, 0).toISOString(), now)).toBe('Mon')
    expect(usageLine({
      model: 'claude-opus-5-5', effort: 'high', ctxTokens: 402_000, ctxWindow: 1_000_000, ctxPercent: 40,
      session: { percent: 62, resetsAt: new Date(2026, 9, 7, 15, 40).toISOString() },
      weekly: { percent: 31, resetsAt: new Date(2026, 9, 12, 9, 0).toISOString() }
    }, now)).toBe('Model: Opus 5.5 · Context: 402k/1.0M (40%) · Session: 62%, resets 15:40 · Weekly: 31%, resets Mon')
  })
})

test('the pane shows the goal, the plan with Now and Next, and empty changes', async ($, on) => {
  mock.env(on, { KOVAN_GOAL: 'Stop the player controls jumping', KOVAN_GOAL_KEY: 'ACME-2453' })
  // No git and no package.json here: the pane must still draw.
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.read', () => { throw new Error('no such file') })
  on('session.cwd', () => ({ value: '/tmp/repo' }))
  on('clock.now', () => ({ value: new Date(2026, 9, 7, 13, 48).getTime() }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, tokens: 402_000, percent: 40 }, rateLimits: [] } }))
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: [] } }))

  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Add a test for the sticky bar', status: 'completed', activeForm: 'Adding a test' },
      { content: 'Fix the type error', status: 'in_progress', activeForm: 'Fixing the type error' },
      { content: 'Check it at iPad width', status: 'pending', activeForm: 'Checking iPad width' },
      { content: 'Write the report', status: 'pending', activeForm: 'Writing the report' }
    ]
  } as never)

  const ui = await $.ui.mount({ plugin: 'kovan', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /GOAL · ACME-2453/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 of 4 done/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /✓ Add a test for the sticky bar/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /● Fix the type error/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /next/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /No files changed yet/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Model: Opus 5.5 · Context: 402k\/1.0M \(40%\)/ })).toBeDefined()
  await ui.unmount()
})

test('an edit lists the file with its counts, and a click opens its diff', async ($, on) => {
  const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const a = 1\n+const a = 2\n'
  mock.env(on, {})
  on('session.cwd', () => ({ value: '/repo' }))
  on('clock.now', () => ({ value: 1_000 }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('fs.read', () => { throw new Error('no such file') })
  on('process.run', ($, e) => {
    const argv = (e as unknown as { argv: string[] }).argv.join(' ')
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv.startsWith('git rev-parse')) return out('/repo\n')
    if (argv.startsWith('git ls-files')) return out('src/a.ts\n')
    if (argv.startsWith('git diff --numstat')) return out('6\t2\tsrc/a.ts\n')
    if (argv.startsWith('git diff HEAD')) return out(DIFF)
    return out('', 1)
  })
  on('tool.call', { tool: 'Edit' }, () => ({ result: {} as never }))

  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'const a = 1', new_string: 'const a = 2' } as never)

  const ui = await $.ui.mount({ plugin: 'kovan', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /\+6 −2/ })).toBeDefined()
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  await ui.press({ key: 'file:/repo/src/a.ts' })
  const code = await ui.find({ type: 'Code' })
  expect(code?.props['source']).toBe(DIFF.replace(/\n$/, ''))
  expect(code?.props['format']).toBe('diff')
  await ui.press({ key: 'file:/repo/src/a.ts' })
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  await ui.unmount()
})

test('Open in Kovan writes a request into the folder Kovan watches and shows its reply', async ($, on) => {
  const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const a = 1\n+const a = 2\n'
  const written: Record<string, string> = {}
  const toasts: string[] = []
  mock.env(on, { KOVAN_OPEN_DIR: '/kovan/open' })
  on('session.cwd', () => ({ value: '/repo' }))
  on('clock.now', () => ({ value: 1_000 }))
  on('clock.sleep', () => ({ value: undefined }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('process.run', ($, e) => {
    const argv = (e as unknown as { argv: string[] }).argv.join(' ')
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv.startsWith('git rev-parse')) return out('/repo\n')
    if (argv.startsWith('git ls-files')) return out('src/a.ts\n')
    if (argv.startsWith('git diff --numstat')) return out('1\t1\tsrc/a.ts\n')
    if (argv.startsWith('git diff HEAD')) return out(DIFF)
    return out('', 1)
  })
  on('fs.write', ($, e) => {
    const { path, text } = e as unknown as { path: string; text: string }
    written[path] = text
    // Kovan answers at once.
    written[path.replace(/\.json$/, '.reply')] = JSON.stringify({ ok: true, message: 'Opened src/a.ts in Kovan.' })
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: (e as unknown as { path: string }).path in written }))
  on('fs.read', ($, e) => {
    const p = (e as unknown as { path: string }).path
    if (p in written) return { value: written[p] }
    throw new Error('no such file')
  })
  on('ui.toast', ($, e) => { toasts.push((e as unknown as { text: string }).text); return { value: undefined } })
  on('tool.call', { tool: 'Edit' }, () => ({ result: {} as never }))

  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'const a = 1', new_string: 'const a = 2' } as never)
  const ui = await $.ui.mount({ plugin: 'kovan', surface: 'terminal', ...PANE })
  expect(await ui.find({ key: 'kovan:/repo/src/a.ts' })).toBeUndefined()
  await ui.press({ key: 'file:/repo/src/a.ts' })
  await ui.press({ key: 'kovan:/repo/src/a.ts' })
  const request = Object.entries(written).find(([p]) => p.startsWith('/kovan/open/') && p.endsWith('.json'))
  expect(JSON.parse(request?.[1] ?? '{}')).toEqual({ repo: '/repo', file: '/repo/src/a.ts' })
  expect(toasts).toEqual(['Opened src/a.ts in Kovan.'])
  await ui.unmount()
})

