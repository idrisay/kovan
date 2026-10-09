import { describe, expect, mock, test } from 'claude-code/testing'

import { changeGroups, checkName, chipLabels, findLinks, packChips, cutAtHunk, fitPath, homeShort, modelName, resets, summarize, tokens, usageLine } from '../hooks/register'

/** `git rev-parse --show-toplevel --show-prefix` for a folder under /repo. */
function gitPlace(e: unknown): string {
  const cwd = (e as { init?: { cwd?: string } }).init?.cwd ?? '/repo'
  return `/repo\n${cwd === '/repo' ? '' : `${cwd.slice('/repo/'.length)}/`}\n`
}

const PANE = { component: 'Pane', requestId: 'kovan', props: { title: 'Kovan', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } } as never

describe('helpers', () => {
  test('names checks by what the command runs', async () => {
    expect(checkName('npm run typecheck')).toBe('Typecheck')
    expect(checkName('npx tsc --noEmit')).toBe('Typecheck')
    expect(checkName('npm test -- player')).toBe('Tests')
    expect(checkName('pytest -q')).toBe('Tests')
    expect(checkName('npx eslint src')).toBe('Lint')
    expect(checkName('git status')).toBeUndefined()
    expect(checkName('npm run type-check && npx eslint . --ext .ts')).toBe('Typecheck')
    expect(checkName('cd web && NODE_ENV=test pnpm test:unit')).toBe('Tests')
    expect(checkName('python -m pytest -q')).toBe('Tests')
    expect(checkName('cargo clippy')).toBe('Lint')
    expect(checkName('php artisan test --filter Lesson')).toBe('Tests')
    expect(checkName('gh pr view 12 --json body | grep -i test')).toBeUndefined()
    expect(checkName('echo "lint likely test"')).toBeUndefined()
    expect(checkName('grep -rn "typecheck" package.json')).toBeUndefined()
    expect(checkName('cat tests/a.test.ts')).toBeUndefined()
  })

  test('summarizes a run by its telling line', async () => {
    expect(summarize('...\n Tests  14 passed (14)\n Duration 2s\n')).toBe('Tests  14 passed (14)')
    expect(summarize('src/a.ts(42,3): error TS2339: nope\n')).toBe('src/a.ts(42,3): error TS2339: nope')
    expect(summarize('just this\n')).toBe('')
    expect(summarize('(node:1) Warning: something\n(Use `node --trace-warnings ...`)\n')).toBe('')
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
      weekly: { percent: 31, resetsAt: new Date(2026, 9, 12, 9, 0).toISOString() },
      cost: 1.031
    }, now)).toBe('Opus 5.5 · ctx 402k/1M 40% · 5h 62% → 15:40 · wk 31% → Mon · $1.03')
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
  expect(await ui.find({ type: 'Text', text: /^Opus 5.5$/ })).toBeDefined()
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
  on('fs.exists', () => ({ value: true }))
  on('process.run', ($, e) => {
    const argv = (e as unknown as { argv: string[] }).argv.join(' ')
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv.startsWith('git rev-parse')) return out(gitPlace(e))
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
    if (argv.startsWith('git rev-parse')) return out(gitPlace(e))
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
  on('fs.exists', ($, e) => {
    const p = (e as unknown as { path: string }).path
    return { value: p in written || !p.startsWith('/kovan/') }
  })
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


describe('changes across repositories', () => {
  const f = (path: string, repo: string, rel: string) => ({ path, repo, rel, add: 1, del: 0, isNew: false })

  test('one repository is the plain list', async () => {
    expect(changeGroups([f('/r/web/a.ts', '/r/web', 'a.ts')], ['/r/web']).flat).toBe(true)
    expect(changeGroups([f('/r/web/a.ts', '/r/web', 'a.ts')], []).flat).toBe(true)
  })

  test("groups by repository, the session's folders first and listed even with no changes, then files in none", async () => {
    const g = changeGroups([
      f('/x/other/z.ts', '/x/other', 'z.ts'),
      f('/r/web/a.ts', '/r/web', 'a.ts'),
      f('/Users/me/.claude/notes.md', '', '~/.claude/notes.md')
    ], ['/r/api', '/r/web'])
    expect(g.flat).toBe(false)
    expect(g.repos.map((r) => [r.name, r.files.map((x) => x.rel)])).toEqual([['api', []], ['web', ['a.ts']], ['other', ['z.ts']]])
    expect(g.others.map((x) => x.rel)).toEqual(['~/.claude/notes.md'])
  })

  test('cuts a long path from the front, keeping the name', async () => {
    expect(fitPath('src/a.ts', 40)).toBe('src/a.ts')
    expect(fitPath('~/.claude/projects/-Users-me-Test-api/memory/feedback.md', 30)).toBe('…/memory/feedback.md')
    expect(fitPath('~/.claude/projects/-Users-me-Test-api/memory/feedback.md', 30).length).toBeLessThanOrEqual(30)
  })

  test('shortens home to ~', async () => {
    expect(homeShort('/Users/me/.claude/x.md', '/Users/me')).toBe('~/.claude/x.md')
    expect(homeShort('/etc/hosts', '/Users/me')).toBe('/etc/hosts')
  })
})

test('a session over two repositories counts each file in its own, and a file in none has no Open in Kovan', async ($, on) => {
  const written: Record<string, string> = {}
  mock.env(on, { KOVAN_OPEN_DIR: '/kovan/open', HOME: '/Users/me', KOVAN_FOLDERS: JSON.stringify(['/r/api', '/r/web']) })
  on('clock.now', () => ({ value: 1_000 }))
  on('clock.sleep', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/r/api' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', ($, e) => {
    const p = (e as unknown as { path: string }).path
    if (p in written) return { value: written[p] }
    if (p === '/Users/me/.claude/notes.md') return { value: 'remember this\n' }
    throw new Error('no such file')
  })
  on('fs.write', ($, e) => {
    const { path, text } = e as unknown as { path: string; text: string }
    written[path] = text
    written[path.replace(/\.json$/, '.reply')] = JSON.stringify({ ok: true, message: 'Opened.' })
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    const { argv, init } = e as unknown as { argv: string[]; init?: { cwd?: string } }
    const cmd = argv.join(' ')
    const cwd = init?.cwd ?? ''
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (cmd.startsWith('git rev-parse')) {
      const root = ['/r/api', '/r/web'].find((r) => cwd === r || cwd.startsWith(`${r}/`))
      return root ? out(`${root}\n${cwd === root ? '' : `${cwd.slice(root.length + 1)}/`}\n`) : out('', 128)
    }
    if (cmd.startsWith('git ls-files') && cwd === '/r/web') return out('src/a.ts\n')
    if (cmd.startsWith('git diff --numstat') && cwd === '/r/web') return out('3\t1\tsrc/a.ts\n')
    return out('', cmd.startsWith('git') ? 0 : 1)
  })
  on('tool.call', { tool: 'Edit' }, () => ({ result: {} as never }))
  await $.tool.call({ tool: 'Edit', file_path: '/r/web/src/a.ts', old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/Users/me/.claude/notes.md', old_string: 'a', new_string: 'b' } as never)

  const ui = await $.ui.mount({ plugin: 'kovan', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /^api$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /no changes/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^web$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Other files/ })).toBeDefined()
  expect(await ui.find({ key: 'file:/r/web/src/a.ts' })).toBeDefined()

  await ui.press({ key: 'file:/r/web/src/a.ts' })
  await ui.press({ key: 'kovan:/r/web/src/a.ts' })
  const request = Object.entries(written).find(([p]) => p.endsWith('.json'))
  expect(JSON.parse(request?.[1] ?? '{}')).toEqual({ repo: '/r/web', file: '/r/web/src/a.ts' })

  await ui.press({ key: 'file:/Users/me/.claude/notes.md' })
  const code = await ui.find({ type: 'Code' })
  expect(code?.props['format']).toBe('source')
  expect(code?.props['source']).toBe('remember this')
  expect(await ui.find({ key: 'kovan:/Users/me/.claude/notes.md' })).toBeUndefined()
  await ui.unmount()
})

describe('links in the chat', () => {
  test('chips drop the shared repo start and pack into rows', async () => {
    const pulls = ['acme-frontend#2736', 'acme-frontend#2680', 'acme-backend#821'].map((key) => ({ kind: 'pull' as const, key }))
    const labels = chipLabels([...pulls, { kind: 'page' as const, key: 'app.acme.test/en' }])
    expect(labels).toEqual(['frontend#2736', 'frontend#2680', 'backend#821', 'app.acme.test/en'])
    expect(chipLabels([{ kind: 'pull', key: 'cli#9000' }, { kind: 'pull', key: 'acme-backend#1' }])).toEqual(['cli#9000', 'acme-backend#1'])
    // 13 + 3 + 13 + 3 + 11 = 43 fits 45; the page goes on the next row.
    expect(packChips(labels, 45)).toEqual([[0, 1, 2], [3]])
    expect(packChips(labels, 10)).toEqual([[0], [1], [2], [3]])
  })

  test('finds pull requests, Figma designs, tickets and local pages, each once, in order', async () => {
    const text = [
      'See https://github.com/acme/acme-frontend/pull/2789 and https://github.com/acme/acme-backend/pull/868/files,',
      'again https://github.com/acme/acme-frontend/pull/2789#discussion. Not https://github.com/acme/acme-frontend/issues/5.',
      'Design: https://www.figma.com/design/yoC3L27adNyJv9lr8EWg7D/Contact-Us-Popup?node-id=1-2 (the target).',
      'Ticket https://acme.atlassian.net/browse/ACME-1234. Page: https://app.acme.test/en/ and http://localhost:3000/lesson/12?x=1.',
      'Not https://api.atlassian.com/ex/jira/x nor https://json-schema.org/draft/2020-12/schema nor https://claude.ai/code/session_1'
    ].join(' ')
    expect(findLinks(text).map((l) => `${l.kind} ${l.key}`)).toEqual([
      'pull acme-frontend#2789', 'pull acme-backend#868', 'figma Contact Us Popup', 'ticket ACME-1234',
      'page app.acme.test/en', 'page localhost:3000/lesson/12'
    ])
    expect(findLinks(text)[1]?.url).toBe('https://github.com/acme/acme-backend/pull/868')
    expect(findLinks(text, true).map((l) => l.key)).toEqual(['acme-frontend#2789', 'acme-backend#868'])
  })
})

test("a pull request linked in a command's output shows in its state's color, the goal's own left out", async ($, on) => {
  mock.env(on, { KOVAN_GOAL_KEY: 'acme-backend#868' })
  on('clock.now', () => ({ value: 1_000 }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('fs.read', () => { throw new Error('no such file') })
  on('process.run', ($, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'gh' && argv[3] === '2789') return out(JSON.stringify({ title: 'feat(qa): lesson+exercise smoke test', state: 'OPEN', isDraft: false }))
    return out('', 1)
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'https://github.com/acme/acme-frontend/pull/2789\nhttps://github.com/acme/acme-backend/pull/868\n', stderr: '', interrupted: false } as never }))

  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' } as never)
  // The title is asked of gh in the background, not in the tool call's way.
  for (let i = 0; i < 50; i++) await Promise.resolve()
  const ui = await $.ui.mount({ plugin: 'kovan', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /^LINKS ─+ 1$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^acme-frontend#2789$/ })).toBeDefined()
  // Design C: the chip takes its state's color, and shows no title.
  const chip = JSON.stringify(await ui.find({ type: 'Text', text: /^acme-frontend#2789$/ }))
  expect(chip).toContain('{"type":"Text","props":{"color":"success"},"children":[{"type":"Link","props":{"href":"https://github.com/acme/acme-frontend/pull/2789"')
  expect(await ui.find({ type: 'Text', text: /lesson\+exercise smoke test/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /acme-backend#868/ })).toBeUndefined()
  await ui.unmount()
})
