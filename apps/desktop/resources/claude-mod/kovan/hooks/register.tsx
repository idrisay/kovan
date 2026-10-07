/**
 * Kovan's pane beside Claude (item 147, design E1 + M1): where the work is
 * and what changed, so a long session doesn't lose you.
 *
 *   Goal       the ticket or pull request Kovan started the session for
 *   Plan       Claude's own plan (TodoWrite, or TaskCreate/TaskUpdate), with
 *              the step in progress as Now and the one after it as Next
 *   Changes    every file this session edited, +/- against HEAD; a click
 *              opens its diff under it
 *   Checks     the tests, typechecks and lints the agent ran, and Run checks
 *   one line   model, context, session and weekly usage
 *
 * Kovan loads it only into Claude sessions it starts (`--plugin-dir`), and
 * hands it the goal in KOVAN_GOAL / KOVAN_GOAL_KEY. Nothing here runs on its
 * own except git reads after an edit: tests run only when the agent runs
 * them or the person presses Run checks.
 */

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Check, DiffView, FileChange, PlanStep, Usage } from '../types'

const PANE = 'kovan'
const plan = atom({ plugin: 'kovan', key: 'plan' } as const, [])
const files = atom({ plugin: 'kovan', key: 'files' } as const, [])
const open = atom({ plugin: 'kovan', key: 'open' } as const, '')
const diff = atom({ plugin: 'kovan', key: 'diff' } as const, { path: '', text: '' })
const checks = atom({ plugin: 'kovan', key: 'checks' } as const, [])
const usage = atom({ plugin: 'kovan', key: 'usage' } as const, { model: '', effort: '', ctxWindow: 0 })

type $ = EngineInterface

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
/** A diff longer than this is cut, and says so: the pane is for a look, Kovan's diff view for reading. */
const DIFF_LINES = 400

// ── what the agent does ────────────────────────────────────────────────────

/** The check a shell command is, by what it runs; undefined for anything else. */
export function checkName(command: string): string | undefined {
  const c = command.toLowerCase()
  if (/\b(tsc|typecheck|type-check|mypy|pyright)\b/.test(c)) return 'Typecheck'
  if (/\b(lint|eslint|ruff|clippy|golangci-lint)\b/.test(c)) return 'Lint'
  if (/\b(test|tests|vitest|jest|pytest|mocha|rspec|phpunit)\b/.test(c)) return 'Tests'
  return undefined
}

/** One line that says how a check went: a summary line if the output has one, else its last line. */
export function summarize(output: string): string {
  const lines = output.split('\n').map((l) => l.replace(/\u001b\[[0-9;]*m/g, '').trim()).filter(Boolean)
  const telling = [...lines].reverse().find((l) =>
    /\b\d+ (passed|failed|errors?|warnings?|problems?)\b|^Tests?:|error TS\d+|^FAIL\b|^PASS\b/i.test(l))
  const line = telling ?? lines[lines.length - 1] ?? ''
  return line.length > 140 ? `${line.slice(0, 139)}…` : line
}

function planFromTodos(todos: unknown, before: readonly PlanStep[], now: number): PlanStep[] {
  if (!Array.isArray(todos)) return [...before]
  return todos.map((t, i) => {
    const todo = t as { content?: unknown; status?: unknown; activeForm?: unknown }
    const text = String(todo.content ?? '')
    const status = todo.status === 'completed' || todo.status === 'in_progress' ? todo.status : 'pending'
    const was = before.find((p) => p.text === text)
    const since = status === 'in_progress' ? (was?.status === 'in_progress' ? was.since : now) : undefined
    return { id: `todo-${i}`, text, active: String(todo.activeForm ?? text), status, ...(since ? { since } : {}) }
  })
}

async function observe($: $, tool: string, input: Record<string, unknown>, ran: { isError?: boolean; deny?: string; result?: unknown; text?: string }) {
  if (ran.deny) return
  const now = await $.clock.now()

  if (EDIT_TOOLS.has(tool) && !ran.isError) {
    const file = String(input['file_path'] ?? input['notebook_path'] ?? '')
    if (!file) return
    await update($, files, (list) => (list.some((f) => f.path === file) ? list : [...list, { path: file, rel: file, add: 0, del: 0, isNew: false }]))
    await refreshFiles($)
    if ((await read($, open)) === file) await loadDiff($, file)
    return
  }

  if (tool === 'TodoWrite') {
    await update($, plan, (before) => planFromTodos(input['todos'], before, now))
    return
  }

  if (tool === 'TaskCreate' && !ran.isError) {
    const created = (ran.result as { task?: { id?: string } } | undefined)?.task
    const text = String(input['subject'] ?? '')
    if (!created?.id || !text) return
    await update($, plan, (list) => [...list, { id: String(created.id), text, active: String(input['activeForm'] ?? text), status: 'pending' as const }])
    return
  }

  if (tool === 'TaskUpdate' && !ran.isError) {
    const id = String(input['taskId'] ?? '')
    const status = input['status']
    await update($, plan, (list) => list
      .filter((p) => !(p.id === id && status === 'deleted'))
      .map((p) => {
        if (p.id !== id) return p
        const next: PlanStep = { ...p }
        if (typeof input['subject'] === 'string') next.text = input['subject']
        if (typeof input['activeForm'] === 'string') next.active = input['activeForm']
        if (status === 'pending' || status === 'in_progress' || status === 'completed') {
          if (status === 'in_progress' && p.status !== 'in_progress') next.since = now
          next.status = status
        }
        return next
      }))
    return
  }

  if (tool === 'Bash') {
    const command = String(input['command'] ?? '')
    const name = checkName(command)
    if (!name || input['run_in_background']) return
    const r = ran.result as { stdout?: string; stderr?: string; interrupted?: boolean } | undefined
    if (r?.interrupted) return
    const output = `${r?.stdout ?? ''}\n${r?.stderr ?? ''}\n${ran.text ?? ''}`
    await record($, { name, ok: !ran.isError, detail: summarize(output) })
  }
}

async function record($: $, check: Check) {
  await update($, checks, (list) => [...list.filter((c) => c.name !== check.name), check])
}

// ── git ────────────────────────────────────────────────────────────────────

async function gitRoot($: $): Promise<string | undefined> {
  const cwd = await $.session.cwd()
  const r = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: 10_000 })
  return r.exitCode === 0 ? r.stdout.trim() : undefined
}

function relativeTo(root: string, file: string): string {
  return file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file
}

/** +/- for every changed file, against HEAD; a file git doesn't track yet is new, all of it added. */
async function refreshFiles($: $) {
  const list = await read($, files)
  if (list.length === 0) return
  const root = await gitRoot($)
  if (!root) {
    await update($, files, (l) => l.map((f) => ({ ...f, rel: f.path })))
    return
  }
  const rels = list.map((f) => relativeTo(root, f.path))
  const tracked = await $.process.run(['git', 'ls-files', '--', ...rels], { cwd: root, timeoutMs: 10_000 })
  const isTracked = new Set(tracked.stdout.split('\n').map((l) => l.trim()).filter(Boolean))
  const numstat = await $.process.run(['git', 'diff', '--numstat', 'HEAD', '--', ...rels], { cwd: root, timeoutMs: 10_000 })
  const counts = new Map<string, { add: number; del: number }>()
  for (const line of numstat.stdout.split('\n')) {
    const [a, d, ...p] = line.split('\t')
    if (!p.length) continue
    counts.set(p.join('\t'), { add: Number(a) || 0, del: Number(d) || 0 })
  }
  const next: FileChange[] = []
  for (const f of list) {
    const rel = relativeTo(root, f.path)
    if (isTracked.has(rel)) {
      const c = counts.get(rel) ?? { add: 0, del: 0 }
      next.push({ path: f.path, rel, add: c.add, del: c.del, isNew: false })
    } else {
      let lines = 0
      try { lines = (await $.fs.read(f.path)).split('\n').filter((_, i, all) => i < all.length - 1 || all[i] !== '').length } catch { /* deleted again */ }
      next.push({ path: f.path, rel, add: lines, del: 0, isNew: true })
    }
  }
  await update($, files, () => next)
}

async function loadDiff($: $, file: string) {
  const root = await gitRoot($)
  const known = (await read($, files)).find((f) => f.path === file)
  let view: DiffView
  if (!root) {
    view = { path: file, text: '', note: 'Not in a git repository, so there is no diff to show.' }
  } else if (known?.isNew) {
    let content = ''
    try { content = await $.fs.read(file) } catch { /* gone */ }
    const lines = content.replace(/\n$/, '').split('\n')
    const shown = lines.slice(0, DIFF_LINES)
    const rel = relativeTo(root, file)
    view = {
      path: file,
      text: [`--- /dev/null`, `+++ b/${rel}`, `@@ -0,0 +1,${shown.length} @@`, ...shown.map((l) => `+${l}`)].join('\n'),
      ...(lines.length > DIFF_LINES ? { note: `First ${DIFF_LINES} of ${lines.length} lines.` } : {})
    }
  } else {
    const r = await $.process.run(['git', 'diff', 'HEAD', '--', relativeTo(root, file)], { cwd: root, timeoutMs: 10_000 })
    const lines = r.stdout.replace(/\n$/, '').split('\n')
    const body = cutAtHunk(lines, DIFF_LINES).join('\n')
    view = r.stdout.trim()
      ? { path: file, text: body, ...(lines.length > DIFF_LINES ? { note: `First ${DIFF_LINES} of ${lines.length} lines.` } : {}) }
      : { path: file, text: '', note: 'No difference from HEAD now.' }
  }
  await update($, diff, () => view)
}

/**
 * The first `max` lines of a diff, cut where a hunk starts: a hunk cut in
 * the middle no longer adds up, and the pane would draw it as plain code.
 */
export function cutAtHunk(lines: readonly string[], max: number): string[] {
  if (lines.length <= max) return [...lines]
  for (let i = max; i > 0; i--) {
    if (lines[i]?.startsWith('@@') || lines[i]?.startsWith('diff --git')) return lines.slice(0, i)
  }
  return lines.slice(0, max)
}

async function toggle($: $, file: string) {
  const was = await read($, open)
  await update($, open, () => (was === file ? '' : file))
  if (was !== file) await loadDiff($, file)
}

/**
 * Open in Kovan (item 148): the file's diff in Kovan's Workspace view. The
 * pane can't reach Kovan's window, so it writes a request into the folder
 * Kovan watches (KOVAN_OPEN_DIR) and shows Kovan's one-line reply.
 */
async function openInKovan($: $, file: string) {
  const dir = await $.env.get('KOVAN_OPEN_DIR')
  if (!dir) return
  const root = await gitRoot($)
  if (!root) {
    $.ui.toast('Not in a git repository, so Kovan has no diff to open.')
    return
  }
  const id = `${await $.clock.now()}-${Math.random().toString(36).slice(2, 8)}`
  await $.fs.write(`${dir}/${id}.json`, JSON.stringify({ repo: root, file: `${root}/${relativeTo(root, file)}` }))
  const reply = `${dir}/${id}.reply`
  // Up to 10 s: Kovan looks at least once a second, and a window just
  // coming forward can take a moment.
  for (let i = 0; i < 50; i++) {
    await $.clock.sleep(200)
    if (!(await $.fs.exists(reply))) continue
    try {
      $.ui.toast((JSON.parse(await $.fs.read(reply)) as { message?: string }).message ?? 'Kovan answered.')
    } catch {
      $.ui.toast('Kovan answered, but the reply was unreadable.')
    }
    return
  }
  $.ui.toast("Kovan didn't answer. Is it running?")
}

/** Run checks: the project's own typecheck, test and lint scripts, one after another. */
async function runChecks($: $) {
  const root = (await gitRoot($)) ?? (await $.session.cwd())
  let scripts: Record<string, string> = {}
  try { scripts = (JSON.parse(await $.fs.read(`${root}/package.json`)) as { scripts?: Record<string, string> }).scripts ?? {} } catch { /* no package.json */ }
  const plan: [string, string][] = [['Typecheck', 'typecheck'], ['Tests', 'test'], ['Lint', 'lint']]
  for (const [name, script] of plan) {
    if (!scripts[script]) continue
    await record($, { name, ok: null, detail: `npm run ${script}…` })
    const r = await $.process.run(['npm', 'run', '-s', script], { cwd: root, timeoutMs: 10 * 60_000 })
    await record($, { name, ok: r.exitCode === 0, detail: summarize(`${r.stdout}\n${r.stderr}`) })
  }
}

async function hasScripts($: $): Promise<boolean> {
  const root = (await gitRoot($)) ?? (await $.session.cwd())
  try {
    const scripts = (JSON.parse(await $.fs.read(`${root}/package.json`)) as { scripts?: Record<string, string> }).scripts ?? {}
    return Boolean(scripts['typecheck'] || scripts['test'] || scripts['lint'])
  } catch {
    return false
  }
}

// ── usage ──────────────────────────────────────────────────────────────────

export function modelName(id: string): string {
  const m = /(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(id)
  if (!m) return id.replace(/\[1m\]$/i, '')
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase()
  return m[3] ? `${family} ${m[2]}.${m[3]}` : `${family} ${m[2]}`
}

export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "15:40" within the day, "Mon" further out. */
export function resets(iso: string | undefined, now: number): string {
  if (!iso) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  if (at.getTime() - now < 20 * 3600_000) {
    return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  }
  return DAYS[at.getDay()] ?? ''
}

export function usageLine(u: Usage, now: number): string {
  const parts: string[] = []
  if (u.model) parts.push(`Model: ${modelName(u.model)}`)
  if (u.ctxWindow) {
    parts.push(u.ctxTokens !== undefined
      ? `Context: ${tokens(u.ctxTokens)}/${tokens(u.ctxWindow)} (${u.ctxPercent ?? Math.round((u.ctxTokens / u.ctxWindow) * 100)}%)`
      : `Context: 0/${tokens(u.ctxWindow)}`)
  }
  for (const [label, w] of [['Session', u.session], ['Weekly', u.weekly]] as const) {
    if (!w) continue
    const when = resets(w.resetsAt, now)
    parts.push(`${label}: ${Math.round(w.percent)}%${when ? `, resets ${when}` : ''}`)
  }
  return parts.join(' · ')
}

async function refreshUsage($: $, effort?: string) {
  const [u, model] = await Promise.all([$.session.usage(), $.session.model()])
  const window = (kind: string) => {
    const w = u.rateLimits.find((r) => r.kind === kind)
    return w ? { percent: w.percentUsed, ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}) } : undefined
  }
  const session = window('five_hour')
  const weekly = window('seven_day')
  await update($, usage, (before) => ({
    model,
    effort: effort ?? before.effort,
    ctxWindow: u.context.window,
    ...(u.context.tokens !== undefined ? { ctxTokens: u.context.tokens } : {}),
    ...(u.context.percent !== undefined ? { ctxPercent: u.context.percent } : {}),
    ...(session ? { session } : {}),
    ...(weekly ? { weekly } : {})
  }))
}

// ── the hooks ──────────────────────────────────────────────────────────────

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'kovan', description: "Open Kovan's pane: the goal, plan, changes, checks and usage" })
    void $.ui.open({ id: PANE, title: 'Kovan' })
    void refreshUsage($).catch(() => undefined)
    // Reset times count down even while nothing happens.
    $.clock.every(60_000, () => { void refreshUsage($).catch(() => undefined) })
    return next(e)
  })

  on('command.run', { command: 'kovan' }, async ($) => {
    await $.ui.open({ id: PANE, title: 'Kovan' })
    return { text: "Kovan's pane is open." }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    try {
      await observe($, String(e.tool), e as unknown as Record<string, unknown>, ran as { isError?: boolean; deny?: string; result?: unknown; text?: string })
      await refreshUsage($)
    } catch {
      // The pane is a view: it never gets in the way of the tool.
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.effort !== undefined) void refreshUsage($, String(e.effort)).catch(() => undefined)
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    void refreshUsage($).catch(() => undefined)
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const cols = Math.max(24, e.props.bodyColumns)
    const [goal, goalKey, openDir, steps, changed, openPath, view, ran, u, now, scripts] = await Promise.all([
      $.env.get('KOVAN_GOAL'), $.env.get('KOVAN_GOAL_KEY'), $.env.get('KOVAN_OPEN_DIR'),
      read($, plan), read($, files), read($, open), read($, diff), read($, checks), read($, usage),
      $.clock.now(), hasScripts($)
    ])

    const head = (label: string, right = '') => {
      const rule = Math.max(2, cols - label.length - right.length - 2)
      return <Text dimColor bold>{`${label} ${'─'.repeat(rule)}${right ? ` ${right}` : ''}`}</Text>
    }
    const row = (left: RenderChildren, right: RenderChildren) => (
      <Box flexDirection="row" width={cols}>
        <Box flexGrow={1} flexShrink={1}>{left}</Box>
        <Box flexShrink={0}>{right}</Box>
      </Box>
    )

    const doing = steps.findIndex((s) => s.status === 'in_progress')
    const nextIdx = steps.findIndex((s, i) => s.status === 'pending' && (doing < 0 || i > doing))
    const done = steps.filter((s) => s.status === 'completed').length
    const added = changed.reduce((n, f) => n + f.add, 0)
    const removed = changed.reduce((n, f) => n + f.del, 0)

    return (
      <Box flexDirection="column" width={cols}>
        {goal ? <Text dimColor bold>{`GOAL${goalKey ? ` · ${goalKey}` : ''}`}</Text> : null}
        {goal ? <Text bold wrap="wrap">{goal}</Text> : null}
        {goal ? <Text> </Text> : null}

        {head('PLAN', steps.length ? `${done} of ${steps.length} done` : '')}
        {steps.length === 0 ? <Text dimColor>No plan yet: it shows once Claude makes one.</Text> : null}
        {steps.map((s, i) => {
          if (s.status === 'completed') return row(<Text dimColor wrap="truncate-end">{`✓ ${s.text}`}</Text>, <Text> </Text>)
          if (i === doing) {
            const mins = s.since ? Math.floor((now - s.since) / 60_000) : 0
            return row(<Text color="warning" bold wrap="truncate-end">{`● ${s.text}`}</Text>, <Text color="warning">{mins > 0 ? ` now · ${mins}m` : ' now'}</Text>)
          }
          if (i === nextIdx) return row(<Text wrap="truncate-end">{`○ ${s.text}`}</Text>, <Text dimColor> next</Text>)
          return row(<Text dimColor wrap="truncate-end">{`○ ${s.text}`}</Text>, <Text> </Text>)
        })}
        <Text> </Text>

        {head('CHANGES', changed.length ? `+${added} −${removed}` : '')}
        {changed.length === 0 ? <Text dimColor>No files changed yet.</Text> : null}
        {changed.map((f) => (
          <Box flexDirection="column" width={cols}>
            {row(
              <Button key={`file:${f.path}`} plain label={`${openPath === f.path ? '▾' : '▸'} ${f.rel}`} onPress={() => { void toggle($, f.path) }} />,
              f.isNew
                ? <Text color="diffAdded">{` new +${f.add}`}</Text>
                : <Text><Text color="diffAdded">{` +${f.add}`}</Text><Text color="diffRemoved">{` −${f.del}`}</Text></Text>
            )}
            {openPath === f.path && view.path === f.path && view.text ? <Code source={view.text} format="diff" path={f.rel} wrap="truncate-end" /> : null}
            {openPath === f.path && view.path === f.path && view.note ? <Text dimColor>{`  ${view.note}`}</Text> : null}
            {openPath === f.path && openDir
              ? <Box marginLeft={2}><Button key={`kovan:${f.path}`} plain label="Open in Kovan" onPress={() => { void openInKovan($, f.path) }} /></Box>
              : null}
          </Box>
        ))}
        <Text> </Text>

        {head('CHECKS')}
        {ran.length === 0 ? <Text dimColor>None yet: tests and typechecks show here when they run.</Text> : null}
        {ran.map((c) => row(
          <Text wrap="truncate-end"><Text color={c.ok === null ? 'subtle' : c.ok ? 'success' : 'error'}>{c.ok === null ? '… ' : '● '}</Text>{c.name}</Text>,
          <Text dimColor wrap="truncate-end">{` ${c.detail}`}</Text>
        ))}
        {scripts ? <Box marginTop={1}><Button key="run-checks" label="Run checks" onPress={() => { void runChecks($) }} /></Box> : null}
        <Text> </Text>

        <Text dimColor wrap="truncate-end">{usageLine(u, now)}</Text>
      </Box>
    )
  })
}
