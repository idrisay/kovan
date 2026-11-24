/**
 * Kovan's pane beside Claude (item 147, design E1 + M1): where the work is
 * and what changed, so a long session doesn't lose you.
 *
 *   Goal       the ticket or pull request Kovan started the session for
 *   Plan       Claude's own plan (TodoWrite, or TaskCreate/TaskUpdate), with
 *              the step in progress as Now and the one after it as Next
 *   Changes    every file this session edited, +/- against HEAD; a click
 *              opens its diff under it. Files a shell command changed count
 *              too, by git status against the session's start (item 165)
 *   Reviewers  the external reviewers Kovan asked for (KOVAN_REVIEWERS), each
 *              not run yet, running, done or failed, as the agent runs them,
 *              with the models it tries under it
 *   Checks     the tests, typechecks and lints the agent ran, and Run checks
 *   one line   model, context, session and weekly usage
 *
 * Kovan loads it only into Claude sessions it starts (`--plugin-dir`), and
 * hands it the goal in KOVAN_GOAL / KOVAN_GOAL_KEY. Nothing here runs on its
 * own except git reads after an edit: tests run only when the agent runs
 * them or the person presses Run checks.
 *
 * A second pane, Changes, shows every changed file's diff at once, in every
 * folder of the session: Claude Code's own Diff tab only knows the folder the
 * session started in (item 165).
 */

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Check, DiffView, FileChange, LinkItem, PlanStep, ReviewerModels, ReviewRun, Usage } from '../types'

const PANE = 'kovan'
const CHANGES = 'kovan-changes'
const plan = atom({ plugin: 'kovan', key: 'plan' } as const, [])
const files = atom({ plugin: 'kovan', key: 'files' } as const, [])
const open = atom({ plugin: 'kovan', key: 'open' } as const, '')
const diff = atom({ plugin: 'kovan', key: 'diff' } as const, { path: '', text: '' })
const checks = atom({ plugin: 'kovan', key: 'checks' } as const, [])
const usage = atom({ plugin: 'kovan', key: 'usage' } as const, { model: '', effort: '', ctxWindow: 0 })
const scripts = atom({ plugin: 'kovan', key: 'scripts' } as const, false)
const folders = atom({ plugin: 'kovan', key: 'folders' } as const, [])
const links = atom({ plugin: 'kovan', key: 'links' } as const, [])
/** Per repository, what was already changed when the session started: not this session's. */
const baseline = atom({ plugin: 'kovan', key: 'baseline' } as const, {})
/** Every changed file's diff, for the Changes pane, by path. */
const diffs = atom({ plugin: 'kovan', key: 'diffs' } as const, {})
const reviews = atom({ plugin: 'kovan', key: 'reviews' } as const, [])
const reviewModels = atom({ plugin: 'kovan', key: 'reviewModels' } as const, {})

/**
 * Asks Claude to keep its plan where the pane can show it (item 165): without
 * a task list the Plan section has nothing to read. The same words every
 * session, so the prompt cache keeps it.
 */
const PLAN_NOTE = "Kovan shows your plan in a pane beside this session, read from your task list. For work of more than a couple of steps, keep the steps as a task list (TaskCreate and TaskUpdate, or TodoWrite), and mark each one in progress and completed as you go."

type $ = EngineInterface

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
/** A diff longer than this is cut, and says so: the pane is for a look, Kovan's diff view for reading. */
const DIFF_LINES = 400

// ── what the agent does ────────────────────────────────────────────────────

const TYPECHECK = new Set(['tsc', 'vue-tsc', 'mypy', 'pyright', 'phpstan', 'psalm'])
const LINT = new Set(['eslint', 'ruff', 'biome', 'stylelint', 'golangci-lint', 'phpcs', 'rubocop', 'prettier', 'flake8', 'pylint'])
const TESTS = new Set(['vitest', 'jest', 'pytest', 'mocha', 'rspec', 'phpunit', 'pest', 'playwright', 'cypress', 'ava', 'tap'])

/** A script's kind by its name: `type-check`, `lint:fix`, `test:unit`, `e2e`. */
function scriptKind(name: string): string | undefined {
  if (/^(type-?check|tsc|types)\b/i.test(name)) return 'Typecheck'
  if (/^lint\b/i.test(name)) return 'Lint'
  if (/^(test|tests|spec|e2e)\b/i.test(name)) return 'Tests'
  return undefined
}

/**
 * The check a shell command is, by the program each of its steps runs;
 * undefined for anything else. Only what is run counts, never a word in its
 * arguments: `gh pr view 12 | grep test` and `echo lint` are not checks
 * (item 154 fix: a pane once called a GitHub query "Tests").
 */
export function checkName(command: string): string | undefined {
  for (const step of command.split(/&&|\|\||;|\||\n/)) {
    let words = step.trim().split(/\s+/).filter(Boolean)
    // What runs a program rather than being one.
    while (words.length && (/^\w+=/.test(words[0]!) || ['env', 'time', 'exec', 'command', 'nice'].includes(words[0]!))) words = words.slice(1)
    if (words[0] === 'timeout') words = words.slice(2)
    if (words[0] === 'bundle' && words[1] === 'exec') words = words.slice(2)
    if (/^python3?$/.test(words[0] ?? '') && words[1] === '-m') words = words.slice(2)
    const program = (words[0] ?? '').split('/').pop() ?? ''
    const args = words.slice(1).filter((w) => !w.startsWith('-'))
    let kind: string | undefined
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(program)) {
      const script = args[0] === 'run' || args[0] === 'run-script' ? args[1] : args[0]
      kind = script ? scriptKind(script) : undefined
    } else if (['npx', 'pnpx', 'bunx'].includes(program) || (program === 'pnpm' && args[0] === 'exec')) {
      const tool = (args[0] ?? '').split('@')[0] ?? ''
      kind = TYPECHECK.has(tool) ? 'Typecheck' : LINT.has(tool) ? 'Lint' : TESTS.has(tool) ? 'Tests' : undefined
    } else if (TYPECHECK.has(program)) kind = 'Typecheck'
    else if (LINT.has(program)) kind = 'Lint'
    else if (TESTS.has(program)) kind = 'Tests'
    else if (program === 'cargo' || program === 'go') kind = args[0] === 'test' ? 'Tests' : args[0] === 'clippy' || args[0] === 'vet' ? 'Lint' : undefined
    else if (program === 'composer' || program === 'make' || program === 'just') kind = args[0] ? scriptKind(args[0]) : undefined
    else if (program === 'php' && args[0] === 'artisan' && args[1] === 'test') kind = 'Tests'
    if (kind) return kind
  }
  return undefined
}

/**
 * One line that says how a check went: the line in its output that counts
 * passes, failures or errors; '' when there is none, and the pane says
 * passed or failed by itself rather than show whatever came last.
 */
export function summarize(output: string): string {
  const lines = output.split('\n').map((l) => l.replace(/\u001b\[[0-9;]*m/g, '').trim()).filter(Boolean)
  const telling = [...lines].reverse().find((l) =>
    /\b\d+ (passed|failed|errors?|warnings?|problems?|tests?)\b|^Tests?:|error TS\d+|^FAIL\b|^PASS\b|^Found \d+ errors?|^All checks passed|^No issues found|^Success:/i.test(l))
  const line = telling ?? ''
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
    await update($, files, (list) => (list.some((f) => f.path === file) ? list : [...list, { path: file, repo: '', rel: file, add: 0, del: 0, isNew: false }]))
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
    void noteShellChanges($).catch(() => undefined)
    const command = String(input['command'] ?? '')
    const running = (await read($, reviews)).filter((r) => r.state === 'running' && !r.taskId).map((r) => r.name)
    const mine = reviewersIn(command, await reviewNames($)).filter((n) => running.includes(n))
    if (mine.length) {
      const res = ran.result as { stdout?: string; stderr?: string; backgroundTaskId?: string; interrupted?: boolean } | undefined
      if (res?.backgroundTaskId) {
        // Running on: its notification settles it.
        await update($, reviews, (list) => list.map((r) => (mine.includes(r.name) && r.state === 'running' && !r.taskId ? { ...r, taskId: res.backgroundTaskId } : r)))
      } else {
        await finishReviews($, mine, `${res?.stdout ?? ''}\n${res?.stderr ?? ''}\n${ran.text ?? ''}`, !ran.isError, Boolean(res?.interrupted))
      }
    }
    const said = ran.result as { stdout?: string } | undefined
    // `gh pr create` prints the new one's link.
    void noteLinks($, `${said?.stdout ?? ''}`, true).catch(() => undefined)
    const name = checkName(command)
    if (!name || input['run_in_background']) return
    const r = ran.result as { stdout?: string; stderr?: string; interrupted?: boolean } | undefined
    if (r?.interrupted) return
    const output = `${r?.stdout ?? ''}\n${r?.stderr ?? ''}\n${ran.text ?? ''}`
    await record($, { name, ok: !ran.isError, detail: summarize(output) })
  }
}

// ── external reviewers (item 167) ──────────────────────────────────────────

/** Words before a step's program: `env`, `nohup`, a loop's `do`. */
const STEP_PREFIXES = ['env', 'time', 'exec', 'command', 'nice', 'nohup', 'do', 'then', 'else', '!']

/** The reviewer names Kovan handed the session, each once: `nv-review (kimi)` is `nv-review`. */
export function reviewerNames(raw: string | undefined): string[] {
  let list: unknown
  try { list = JSON.parse(raw ?? '[]') } catch { list = [] }
  if (!Array.isArray(list)) return []
  const names = list.map((n) => String(n).trim().split(/[\s(]/)[0] ?? '').filter((n) => /^[\w.-]+$/.test(n))
  return [...new Set(names)]
}

/**
 * The reviewers a shell command runs: a step whose program, past env
 * assignments and `source`, is one of them, by its name or a path to it.
 * Quotes split steps too, so `zsh -c "source $SNAP; nv-review"` counts and
 * `echo "running nv-review"` or `type nv-review` don't.
 */
export function reviewersIn(command: string, names: readonly string[]): string[] {
  const found: string[] = []
  for (const step of command.split(/&&|\|\||;|\||\n|"|'|\$\(|`|\(|\)/)) {
    let words = step.trim().split(/\s+/).filter(Boolean)
    while (words.length && (/^\w+=/.test(words[0]!) || STEP_PREFIXES.includes(words[0]!))) words = words.slice(1)
    if (words[0] === 'timeout') words = words.slice(2)
    const program = (words[0] ?? '').split('/').pop() ?? ''
    if (names.includes(program) && !found.includes(program)) found.push(program)
  }
  return found
}

/** Text without terminal colours or the title sequences a sourced shell prints. */
function plain(text: string): string {
  return text.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
}

/** Where each name stands in a line, as a word: `openrouter/free` is a model, not the openrouter reviewer. */
function namesAt(line: string, names: readonly string[]): { name: string; at: number }[] {
  return names.flatMap((name) => [...line.matchAll(new RegExp(`(?<![\\w.-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/-])`, 'g'))].map((m) => ({ name, at: m.index! })))
}

/**
 * How a reviewer ended, from the status lines agents print as they run them:
 * `nv-review exit 1`, `cc-token retry rc=1`, `cc-orca attempt 3 failed`,
 * `cc-review: cc-token FAILED after 2s — …`, `… ok`. Each status belongs to
 * the reviewer named nearest before it on its line, and the last one wins:
 * a retry that ends ok is done. Those echoes make the whole command succeed,
 * so they beat its exit code. Also the VERDICT line one printed, and the
 * lines that were its own, to read a failure's reason from.
 */
export function reviewOutcome(output: string, name: string, names: readonly string[] = [name]): { exit?: number; failed?: boolean; verdict?: string; lines?: string } {
  const clean = plain(output)
  const all = names.includes(name) ? names : [...names, name]
  let exit: number | undefined
  let failed: boolean | undefined
  const own: string[] = []
  for (const line of clean.split('\n')) {
    const at = namesAt(line, all)
    if (at.length === 0) continue
    let mine = false
    for (const status of line.matchAll(/\b(?:exit(?:\s+code)?|rc)\s*[:=]?\s*(\d+)\b|\b(failed|FAILED)\b(?!,?\s+retrying)|\b(ok)\b/g)) {
      const owner = at.filter((n) => n.at < status.index!).sort((a, b) => b.at - a.at)[0]?.name
      if (owner !== name) continue
      mine = true
      if (status[1] !== undefined) { exit = Number(status[1]); failed = exit !== 0 } else { exit = undefined; failed = status[2] !== undefined }
    }
    if (mine) own.push(line.trim())
  }
  const verdict = [...clean.matchAll(/^\s*\**VERDICT\**:?\**\s*(.+?)\s*$/gim)].pop()
  return {
    ...(exit !== undefined ? { exit } : {}),
    ...(failed !== undefined ? { failed } : {}),
    ...(verdict ? { verdict: verdict[1]!.replace(/\*+/g, '').slice(0, 60) } : {}),
    ...(own.length ? { lines: own.join('\n') } : {})
  }
}

/**
 * Why a reviewer failed, in a few words, from what it and its logs said:
 * `no credit (403)`, `rate-limited (429)`, `model retired (410)`. The HTTP
 * code goes first: a 429 says "add credits" too. Else, when `anyLine`, the
 * last line that says error or failed, past its "—".
 */
export function failReason(text: string, anyLine = true): string | undefined {
  const t = plain(text)
  const code = [...t.matchAll(/\b(?:API Error:?\s*(?:Request rejected\s*\()?|HTTP(?: error)?:?\s*|status(?: code)?:?\s*)([1-5]\d\d)\b/gi)].pop()?.[1]
  const said = (words: string) => (code ? `${words} (${code})` : words)
  if (code === '429' || (!code && /rate.?limit|too many requests|capacity is limited/i.test(t))) return said('rate-limited')
  if (code === '402' || /credit limit|insufficient (?:credit|balance|funds|quota)|gift balance|out of credits?|no credits? left|exceeded your current quota/i.test(t)) return said('no credit')
  if (code === '410' || /end of life|end-of-life|no longer (?:available|supported)/i.test(t)) return said('model retired')
  if (code === '401' || /unauthori[sz]ed|invalid (?:api )?key|no key at|missing (?:api )?key/i.test(t)) return said('bad or missing key')
  if (code === '404' || /model not found|unknown model|no such model|not a valid model/i.test(t)) return said('model not found')
  if (code === '403') return said('forbidden')
  if (/timed out|curl: \(28\)/i.test(t)) return said('timed out')
  if (/empty response|no stream chunks|empty stream/i.test(t)) return said('empty response')
  if (code?.startsWith('5') || /unexpected (?:server )?error|internal server error|bad gateway|service unavailable/i.test(t)) return said('server error')
  if (!anyLine) return code ? `HTTP ${code}` : undefined
  const line = t.split('\n').map((l) => l.trim()).filter((l) => /error|failed/i.test(l)).pop()
  return line ? line.replace(/^.*?(?:—|--)\s*/, '').slice(0, 60) : code ? `HTTP ${code}` : undefined
}

/**
 * The files a command writes a reviewer's output to, read for the reason
 * when it fails: the `>`, `2>` and `-o` targets of its own step, and any file
 * named after it (`cc-token-retry.log`), with the command's own `R=…`
 * variables, `$HOME` and `~` filled in. A path still holding a variable is
 * left out.
 */
export function reviewLogs(command: string, name: string, home?: string): string[] {
  const vars: Record<string, string> = home ? { HOME: home } : {}
  const fill = (s: string) => s.replace(/^~(?=\/)/, home ?? '~').replace(/\$\{?(\w+)\}?/g, (m, v: string) => vars[v] ?? m)
  for (const a of command.matchAll(/(?:^|[;&|\n(]\s*)(\w+)=("[^"]*"|'[^']*'|[^\s;&|)]*)/g)) vars[a[1]!] = fill(a[2]!.replace(/^["']|["']$/g, ''))
  const found: string[] = []
  for (const step of command.split(/&&|\|\||;|\||\n|\$\(|`|\(|\)/)) {
    let words = step.trim().split(/\s+/).filter(Boolean)
    while (words.length && (/^\w+=/.test(words[0]!) || STEP_PREFIXES.includes(words[0]!))) words = words.slice(1)
    if (words[0] === 'timeout') words = words.slice(2)
    const isMine = (words[0] ?? '').replace(/["']/g, '').split('/').pop() === name
    for (const t of step.matchAll(/(?:\d?>>?|&>)\s*(?!&)("?)([^\s"';&|)]+)\1|(?:^|\s)(?:-o|--output)\s+("?)([^\s"';&|)]+)\3/g)) {
      const file = fill(t[2] ?? t[4] ?? '')
      if (!file.startsWith('/') || file.includes('$') || file.startsWith('/dev/')) continue
      if ((isMine || (file.split('/').pop() ?? '').includes(name)) && !found.includes(file)) found.push(file)
    }
  }
  return found.slice(0, 8)
}

/** Each `<task-notification>` in a text: its task id, status and exit code. */
export function taskNotices(text: string): { id: string; status: string; exit?: number; outputFile?: string }[] {
  const notices: { id: string; status: string; exit?: number; outputFile?: string }[] = []
  for (const block of text.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? []) {
    const tag = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block)?.[1]?.trim()
    const id = tag('task-id')
    if (!id) continue
    const exit = /exit code (\d+)/.exec(tag('summary') ?? '')
    const outputFile = tag('output-file')
    notices.push({ id, status: tag('status') ?? '', ...(exit ? { exit: Number(exit[1]) } : {}), ...(outputFile ? { outputFile } : {}) })
  }
  return notices
}

async function reviewNames($: $): Promise<string[]> {
  return reviewerNames(await $.env.get('KOVAN_REVIEWERS'))
}

/** Marks the reviewers a command is about to run as running. */
async function startReviews($: $, command: string): Promise<string[]> {
  const started = reviewersIn(command, await reviewNames($))
  if (started.length === 0) return started
  const now = await $.clock.now()
  const configured = await read($, reviewModels)
  const home = await $.env.get('HOME')
  await update($, reviews, (list) => [
    ...list.filter((r) => !started.includes(r.name)),
    ...started.map((name): ReviewRun => {
      const models = runModels(command, name, configured[name]?.models ?? [])
      const logs = reviewLogs(command, name, home)
      return { name, state: 'running', since: now, ...(models ? { models } : {}), ...(logs.length ? { logs } : {}) }
    })
  ])
  return started
}

/**
 * Settles reviewers from what their command printed and how it ended. A
 * failed one says why: from its own lines, else from the logs its command
 * wrote (the tail of each: the error is at the end).
 */
async function finishReviews($: $, names: readonly string[], output: string, ok: boolean, stopped = false) {
  const now = await $.clock.now()
  const all = await reviewNames($)
  const logs: Record<string, string> = {}
  for (const r of await read($, reviews)) {
    if (!names.includes(r.name) || r.state !== 'running') continue
    logs[r.name] = ''
    for (const file of r.logs ?? []) {
      try { logs[r.name] += `${(await $.fs.read(file)).slice(-20_000)}\n` } catch { /* never written */ }
    }
  }
  await update($, reviews, (list) => list.map((r) => {
    if (!names.includes(r.name) || r.state !== 'running') return r
    const { exit, failed: said, verdict, lines } = reviewOutcome(output, r.name, all)
    const failed = exit !== undefined ? exit !== 0 : said ?? !ok
    const state: ReviewRun['state'] = stopped ? 'stopped' : failed ? 'failed' : 'done'
    // Its own `attempt 3 failed` says nothing new: a known cause there, else the logs'.
    const reason = failed && !stopped ? failReason(lines ?? '', false) ?? failReason(logs[r.name] ?? '') : undefined
    const detail = failed ? reason ?? verdict ?? (exit !== undefined ? `exit ${exit}` : undefined) : verdict
    const { taskId: _, logs: __, ...rest } = r
    return { ...rest, state, ended: now, ...(detail ? { detail } : {}) }
  }))
}

/** A background task ended: the reviewers it ran, settled from its output file. */
async function noteTaskNotices($: $, text: string) {
  for (const notice of taskNotices(text)) {
    const names = (await read($, reviews)).filter((r) => r.taskId === notice.id && r.state === 'running').map((r) => r.name)
    if (names.length === 0) continue
    let output = ''
    if (notice.outputFile) { try { output = await $.fs.read(notice.outputFile) } catch { /* gone */ } }
    const stopped = notice.status === 'killed' || notice.status === 'stopped'
    const ok = notice.status === 'completed' && (notice.exit === undefined || notice.exit === 0)
    await finishReviews($, names, output, ok, stopped)
  }
}

/** Every reviewer Kovan asked for, in its order, with how far each has got. */
export function reviewList(names: readonly string[], runs: readonly ReviewRun[]): ReviewRun[] {
  return names.map((name) => runs.find((r) => r.name === name) ?? { name, state: 'waiting' as const })
}

/** The section's count: `2 of 7 done`, failures said too. */
export function reviewSummary(rows: readonly ReviewRun[]): string {
  const done = rows.filter((r) => r.state === 'done').length
  const failed = rows.filter((r) => r.state === 'failed').length
  return `${done} of ${rows.length} done${failed ? ` · ${failed} failed` : ''}`
}

/** A dot plus a word, as every state in Kovan: it still reads without colour. */
const REVIEW_LOOK = {
  waiting: { mark: '○', word: 'not run yet', color: 'subtle' },
  running: { mark: '●', word: 'running', color: 'warning' },
  done: { mark: '●', word: 'done', color: 'success' },
  failed: { mark: '●', word: 'failed', color: 'error' },
  stopped: { mark: '○', word: 'stopped', color: 'subtle' }
} as const

// ── each reviewer's models ────────────────────────────────────────────────

/** `deepseek-ai/deepseek-v4.1-flash` → `deepseek-v4.1-flash`, `…/inkling:free` → `inkling:free`; a bare word keeps its vendor: `openrouter/free`. */
export function shortModel(id: string): string {
  const last = id.split('/').pop() ?? id
  return /[-:.\d]/.test(last) ? last : id
}

/**
 * The models a reviewer's own source tries, in order: a shell function's
 * `${NV_MODEL:-…}` default then its `${NV_FALLBACK-…}` list, or a script's
 * `DEFAULT_MODELS = [ … ]` then any `…_FALLBACK = "…"` it ends on
 * (or-review's OpenCode one).
 */
export function sourceModels(source: string): string[] {
  const shellDefault = (suffix: string) => new RegExp(`\\$\\{\\w*_${suffix}:?-([^}]*)\\}`).exec(source)?.[1]?.trim()
  const first = shellDefault('MODEL')
  if (first) return [...new Set([first, ...(shellDefault('FALLBACK') ?? '').split(/\s+/).filter(Boolean)])]
  const list = /^DEFAULT_MODELS\s*=\s*\[([\s\S]*?)\]/m.exec(source)
  const items = (list?.[1] ?? '').replace(/#.*$/gm, '')
  const models = [...items.matchAll(/["']([^"'\s]+)["']/g)].map((m) => m[1]!)
  if (models.length === 0) return []
  const after = [...source.matchAll(/^\w*FALLBACK\w*\s*=\s*["']([^"'\s]+)["']/gm)].map((m) => m[1]!)
  return [...new Set([...models, ...after])]
}

/** OpenCode's model for a review: its plan agent's, which reviews run as, else the default. */
export function opencodeModel(json: string): string | undefined {
  try {
    const c = JSON.parse(json) as { model?: string; agent?: { plan?: { model?: string } } }
    return c.agent?.plan?.model ?? c.model
  } catch { return undefined }
}

/** Codex's model and reasoning effort, from config.toml's top level: `gpt-6-sol · max`. */
export function codexModel(toml: string): string | undefined {
  const top = toml.split(/^\s*\[/m)[0] ?? ''
  const model = /^\s*model\s*=\s*"([^"]+)"/m.exec(top)?.[1]
  const effort = /^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(top)?.[1]
  return model ? `${model}${effort ? ` · ${effort}` : ''}` : undefined
}

/** What `zsh -ic SOURCES zsh <names>` printed, split back into each reviewer's source. */
export function splitSources(stdout: string): Record<string, string> {
  const out: Record<string, string> = {}
  let name: string | undefined
  for (const line of stdout.split('\n')) {
    const marker = /^@@kovan-source ([\w.-]+)$/.exec(line)
    if (marker) { name = marker[1]!; out[name] = ''; continue }
    if (name !== undefined) out[name] += `${line}\n`
  }
  return out
}

/**
 * Each reviewer's models from its source, `known` (configs read directly)
 * first. One with none of its own that runs others by name, as cc-review
 * runs cc-token and cc-orca, says theirs.
 */
export function reviewerModels(sources: Record<string, string>, known: Record<string, string[]> = {}): Record<string, ReviewerModels> {
  const own: Record<string, ReviewerModels> = {}
  for (const [name, models] of Object.entries(known)) if (models.length) own[name] = { models: models.map(shortModel) }
  for (const [name, source] of Object.entries(sources)) {
    const models = own[name] ? [] : sourceModels(source)
    if (models.length) own[name] = { models: models.map(shortModel) }
  }
  const out = { ...own }
  for (const [name, source] of Object.entries(sources)) {
    if (out[name]) continue
    const via = Object.keys(own).filter((other) => other !== name && new RegExp(`(^|[^\\w-])${other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`).test(source))
    if (via.length) out[name] = { models: [], via }
  }
  return out
}

/**
 * The models a command picks for a reviewer over its defaults, or undefined
 * when it picks none: `--model x` / `-m x` alone, or `NV_MODEL=x` with the
 * step's own `NV_FALLBACK=…` or else the configured fallbacks after it.
 */
export function runModels(command: string, name: string, configured: readonly string[]): string[] | undefined {
  // Quotes don't split here: `NV_FALLBACK="a b"` is one assignment.
  for (const step of command.split(/&&|\|\||;|\||\n|\$\(|`|\(|\)/)) {
    let words = step.trim().split(/\s+/).filter(Boolean)
    const env: Record<string, string> = {}
    while (words.length && (/^\w+=/.test(words[0]!) || ['env', 'time', 'exec', 'command', 'nice', 'nohup'].includes(words[0]!))) {
      const assign = /^(\w+)=(.*)$/.exec(words[0]!)
      if (assign) env[assign[1]!] = assign[2]!.replace(/^["']|["']$/g, '')
      words = words.slice(1)
    }
    if (words[0] === 'timeout') words = words.slice(2)
    if ((words[0] ?? '').replace(/["']/g, '').split('/').pop() !== name) continue
    const flag = words.findIndex((w) => w === '--model' || w === '-m' || w.startsWith('--model='))
    if (flag >= 0) {
      const value = words[flag]!.startsWith('--model=') ? words[flag]!.slice(8) : words[flag + 1]
      if (value) return [shortModel(value.replace(/["']/g, ''))]
    }
    const model = Object.entries(env).find(([k]) => k.endsWith('_MODEL'))?.[1]
    const fallback = Object.entries(env).find(([k]) => k.endsWith('_FALLBACK'))?.[1]
    if (model === undefined && fallback === undefined) return undefined
    const rest = fallback !== undefined ? fallback.split(/\s+/).filter(Boolean).map(shortModel) : configured.slice(1)
    const first = model !== undefined ? shortModel(model) : configured[0]
    return [...new Set([...(first ? [first] : []), ...rest])]
  }
  return undefined
}

/** The line under a reviewer: `deepseek-v4.1-flash → minimax-m3.1-flash`, or `cc-token … · cc-orca …`. */
export function modelLine(run: ReviewRun, all: Record<string, ReviewerModels>): string {
  if (run.models?.length) return run.models.join(' → ')
  const own = all[run.name]
  if (!own) return ''
  if (own.models.length) return own.models.join(' → ')
  return (own.via ?? []).map((v) => `${v} ${(all[v]?.models ?? []).join(' → ')}`).join(' · ')
}

/**
 * Prints each name's source after a marker line: a shell function's body, a
 * script whole (`#!` first), a binary not at all. Interactive, as that is
 * where the functions live.
 */
const SOURCES = 'for n; do print -r -- "@@kovan-source $n"; case "$(whence -w -- "$n")" in (*function) whence -f -- "$n" ;; (*command) f="$(whence -p -- "$n")"; [[ "$(head -c 2 "$f" 2>/dev/null)" == "#!" ]] && head -c 200000 "$f" ;; esac; done'

/** Reads where each reviewer keeps its models: OpenCode's and Codex's configs, and the rest's own source. */
async function refreshReviewModels($: $) {
  const names = await reviewNames($)
  if (names.length === 0) return
  const home = await $.env.get('HOME')
  const file = async (path: string) => { try { return await $.fs.read(path) } catch { return '' } }
  const known: Record<string, string[]> = {}
  if (home && names.includes('opencode')) {
    const m = opencodeModel(await file(`${home}/.config/opencode/opencode.json`))
    if (m) known['opencode'] = [m]
  }
  if (home && names.includes('codex')) {
    const m = codexModel(await file(`${home}/.codex/config.toml`))
    if (m) known['codex'] = [m]
  }
  // In a session of its own (item 168): an interactive zsh sharing Claude's
  // terminal takes its foreground, and Claude, reading keys, is stopped
  // ("suspended (tty input)"). Without a terminal it has no job control.
  const r = await $.process.run(
    ['/usr/bin/perl', '-MPOSIX', '-e', 'POSIX::setsid(); exec @ARGV or die', 'zsh', '-ic', SOURCES, 'zsh', ...names.filter((n) => !known[n])],
    { timeoutMs: 20_000 }
  )
  const found = reviewerModels(splitSources(r.stdout), known)
  await update($, reviewModels, () => found)
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

/** Where a folder sits in its repository: the root, and the folder relative to it ('' at the root). */
type Place = { root: string; prefix: string }

// A folder's repository doesn't change during a session: asked once per folder.
const places = new Map<string, Promise<Place | undefined>>()

function dirOf(file: string): string {
  const i = file.lastIndexOf('/')
  return i > 0 ? file.slice(0, i) : '/'
}

/**
 * The repository a folder is in, or undefined outside every one. Asked of
 * git in that folder, so a session that spans repositories (Kovan's added
 * folders) counts each file against its own (item 152).
 */
function placeOf($: $, dir: string): Promise<Place | undefined> {
  let found = places.get(dir)
  if (!found) {
    found = (async () => {
      // A folder deleted since: ask its nearest parent that still exists.
      let at = dir
      while (at !== '/' && !(await $.fs.exists(at))) at = dirOf(at)
      if (at !== dir) return placeOf($, at).then((p) => p && { root: p.root, prefix: `${p.prefix}${dir.slice(at.length + 1)}/` })
      const r = await $.process.run(['git', 'rev-parse', '--show-toplevel', '--show-prefix'], { cwd: dir, timeoutMs: 10_000 })
      if (r.exitCode !== 0) return undefined
      const [root = '', prefix = ''] = r.stdout.split('\n')
      return root ? { root: root.trim(), prefix: prefix.trim() } : undefined
    })()
    places.set(dir, found)
  }
  return found
}

/** The Changes section's groups: one per repository, the session's folders first, then files in none. */
export type ChangeGroups = {
  /** One repository and nothing else: the plain list, no headings. */
  flat: boolean;
  repos: { root: string; name: string; files: FileChange[] }[];
  others: FileChange[];
}

export function changeGroups(changed: readonly FileChange[], roots: readonly string[]): ChangeGroups {
  const order = [...roots]
  for (const f of changed) if (f.repo && !order.includes(f.repo)) order.push(f.repo)
  const repos = order.map((root) => ({ root, name: root.slice(root.lastIndexOf('/') + 1) || root, files: changed.filter((f) => f.repo === root) }))
  const others = changed.filter((f) => !f.repo)
  return { flat: repos.length <= 1 && others.length === 0, repos, others }
}

/** A path cut from the front to `room` cells, so the file's own name always shows. */
export function fitPath(path: string, room: number): string {
  if (path.length <= room) return path
  const tail = path.slice(path.length - Math.max(1, room - 1))
  const slash = tail.indexOf('/')
  return `…${slash > 0 && tail.length - slash > 8 ? tail.slice(slash) : tail}`
}

/** A path for a file in no repository: `~` for home, so the row stays readable. */
export function homeShort(file: string, home: string | undefined): string {
  return home && file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file
}

/** The repositories of the folders Kovan started the session in, main first. */
async function refreshFolders($: $) {
  let list: unknown
  try { list = JSON.parse((await $.env.get('KOVAN_FOLDERS')) ?? '[]') } catch { list = [] }
  const roots: string[] = []
  for (const folder of Array.isArray(list) ? list : []) {
    if (typeof folder !== 'string' || !folder.startsWith('/')) continue
    const place = await placeOf($, folder.replace(/\/+$/, ''))
    if (place && !roots.includes(place.root)) roots.push(place.root)
  }
  await update($, folders, () => roots)
  const known = await read($, baseline)
  for (const root of roots) {
    if (known[root]) continue
    const dirty = await changedPaths($, root)
    await update($, baseline, (b) => (b[root] ? b : { ...b, [root]: dirty }))
  }
}

/** Paths git reports changed in a repository, untracked files included; [] when git can't say. */
async function changedPaths($: $, root: string): Promise<string[]> {
  const r = await $.process.run(['git', 'status', '--porcelain', '-z', '-uall'], { cwd: root, timeoutMs: 10_000 })
  return r.exitCode === 0 ? porcelainPaths(r.stdout) : []
}

/**
 * `git status --porcelain -z`'s paths. A rename or copy is followed by its
 * old path, which is skipped: the file is where it is now.
 */
export function porcelainPaths(out: string): string[] {
  const parts = out.split('\0')
  const paths: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!
    if (entry.length < 4) continue
    paths.push(entry.slice(3))
    if (entry[0] === 'R' || entry[0] === 'C') i++
  }
  return paths
}

/**
 * Files a shell command changed (`sed -i`, a script, a formatter): what git
 * now reports changed in the session's repositories that wasn't at the
 * start and isn't listed yet. Edit and Write report themselves; this is
 * for everything else.
 */
async function noteShellChanges($: $) {
  const roots = await read($, folders)
  if (roots.length === 0) return
  const before = await read($, baseline)
  const listed = new Set((await read($, files)).map((f) => f.path))
  const found: string[] = []
  for (const root of roots) {
    if (!before[root]) continue
    const was = new Set(before[root])
    for (const rel of await changedPaths($, root)) {
      const file = `${root}/${rel}`
      if (!was.has(rel) && !listed.has(file)) found.push(file)
    }
  }
  if (found.length === 0) return
  await update($, files, (list) => [
    ...list,
    ...found.filter((p) => !list.some((f) => f.path === p)).map((p) => ({ path: p, repo: '', rel: p, add: 0, del: 0, isNew: false }))
  ])
  await refreshFiles($)
}

/**
 * +/- for every changed file, each against its own repository's HEAD; a
 * file git doesn't track yet is new, all of it added. A file in no
 * repository has no counts.
 */
async function refreshFiles($: $) {
  const list = await read($, files)
  if (list.length === 0) return
  // Normally read at session start; a reload or a slow start can miss it.
  if ((await read($, folders)).length === 0) await refreshFolders($)
  const home = await $.env.get('HOME')
  const placed = await Promise.all(list.map(async (f) => ({ f, place: await placeOf($, dirOf(f.path)) })))
  const byRoot = new Map<string, { f: FileChange; rel: string }[]>()
  const next = new Map<string, FileChange>()
  for (const { f, place } of placed) {
    if (!place) {
      next.set(f.path, { path: f.path, repo: '', rel: homeShort(f.path, home), add: 0, del: 0, isNew: false })
      continue
    }
    const rel = `${place.prefix}${f.path.slice(f.path.lastIndexOf('/') + 1)}`
    byRoot.set(place.root, [...(byRoot.get(place.root) ?? []), { f, rel }])
  }
  for (const [root, group] of byRoot) {
    const rels = group.map((g) => g.rel)
    const tracked = await $.process.run(['git', 'ls-files', '--', ...rels], { cwd: root, timeoutMs: 10_000 })
    const isTracked = new Set(tracked.stdout.split('\n').map((l) => l.trim()).filter(Boolean))
    const numstat = await $.process.run(['git', 'diff', '--numstat', 'HEAD', '--', ...rels], { cwd: root, timeoutMs: 10_000 })
    const counts = new Map<string, { add: number; del: number }>()
    for (const line of numstat.stdout.split('\n')) {
      const [a, d, ...p] = line.split('\t')
      if (!p.length) continue
      counts.set(p.join('\t'), { add: Number(a) || 0, del: Number(d) || 0 })
    }
    for (const { f, rel } of group) {
      if (isTracked.has(rel)) {
        const c = counts.get(rel) ?? { add: 0, del: 0 }
        next.set(f.path, { path: f.path, repo: root, rel, add: c.add, del: c.del, isNew: false })
      } else {
        let lines = 0
        try { lines = (await $.fs.read(f.path)).split('\n').filter((_, i, all) => i < all.length - 1 || all[i] !== '').length } catch { /* deleted again */ }
        next.set(f.path, { path: f.path, repo: root, rel, add: lines, del: 0, isNew: true })
      }
    }
  }
  await update($, files, (now) => now.map((f) => next.get(f.path) ?? f))
  if ((await $.ui.panes()).some((pane) => pane.id === CHANGES)) await loadAllDiffs($)
}

/** Every listed file's diff, for the Changes pane: asked when it opens and after each change. */
async function loadAllDiffs($: $) {
  const list = await read($, files)
  const views = await Promise.all(list.map((f) => diffOf($, f.path)))
  await update($, diffs, () => Object.fromEntries(views.map((v) => [v.path, v])))
}

async function loadDiff($: $, file: string) {
  const view = await diffOf($, file)
  await update($, diff, () => view)
}

async function diffOf($: $, file: string): Promise<DiffView> {
  const known = (await read($, files)).find((f) => f.path === file)
  const root = known?.repo
  let view: DiffView
  if (!root) {
    // No repository to diff against: the file as it is now.
    let content: string | undefined
    try { content = await $.fs.read(file) } catch { /* gone */ }
    const lines = (content ?? '').replace(/\n$/, '').split('\n')
    view = content === undefined
      ? { path: file, text: '', note: "Not in a git repository, and the file isn't there now." }
      : {
          path: file, text: lines.slice(0, DIFF_LINES).join('\n'), plain: true,
          note: `Not in a git repository: the file as it is now${lines.length > DIFF_LINES ? `, first ${DIFF_LINES} of ${lines.length} lines` : ''}.`
        }
  } else if (known.isNew) {
    let content = ''
    try { content = await $.fs.read(file) } catch { /* gone */ }
    const lines = content.replace(/\n$/, '').split('\n')
    const shown = lines.slice(0, DIFF_LINES)
    view = {
      path: file,
      text: [`--- /dev/null`, `+++ b/${known.rel}`, `@@ -0,0 +1,${shown.length} @@`, ...shown.map((l) => `+${l}`)].join('\n'),
      ...(lines.length > DIFF_LINES ? { note: `First ${DIFF_LINES} of ${lines.length} lines.` } : {})
    }
  } else {
    const r = await $.process.run(['git', 'diff', 'HEAD', '--', known.rel], { cwd: root, timeoutMs: 10_000 })
    const lines = r.stdout.replace(/\n$/, '').split('\n')
    const body = cutAtHunk(lines, DIFF_LINES).join('\n')
    view = r.stdout.trim()
      ? { path: file, text: body, ...(lines.length > DIFF_LINES ? { note: `First ${DIFF_LINES} of ${lines.length} lines.` } : {}) }
      : { path: file, text: '', note: 'No difference from HEAD now.' }
  }
  return view
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
  const known = (await read($, files)).find((f) => f.path === file)
  if (!known?.repo) {
    $.ui.toast('That file is in no git repository, so Kovan has no diff to open.')
    return
  }
  const id = `${await $.clock.now()}-${Math.random().toString(36).slice(2, 8)}`
  await $.fs.write(`${dir}/${id}.json`, JSON.stringify({ repo: known.repo, file: `${known.repo}/${known.rel}` }))
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

/**
 * Whether Run checks has anything to run. Worked out at the start, never
 * while drawing: a git call inside a draw is cut off when the next draw
 * starts, and the pane then fails to draw at all.
 */
async function refreshScripts($: $) {
  const has = await hasScripts($)
  await update($, scripts, () => has)
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

// ── links in the chat (item 154) ──────────────────────────────────────────

type Found = Omit<LinkItem, 'title' | 'state'>

/** A URL's end as prose leaves it: a full stop, a bracket or a quote after it isn't part of it. */
function trimUrl(url: string): string {
  return url.replace(/[).,;:!?'"`\]>*_]+$/, '')
}

/**
 * The links a text names that the pane lists, each once, in the order they
 * first appear:
 *   pull     github.com/<owner>/<repo>/pull/<n>       acme-frontend#2789
 *   figma    figma.com/design/<file>/<Name>           Contact Us popup
 *   ticket   <site>.atlassian.net/browse/<KEY-1>      ACME-1234
 *   page     a local site: localhost, 127.0.0.1, *.test, *.local, *.localhost
 * `onlyPulls` for a command's output, where everything else is noise (API
 * hosts, avatars, schemas) and a pull request is what `gh pr create` prints.
 */
export function findLinks(text: string, onlyPulls = false): Found[] {
  const found: Found[] = []
  const add = (item: Found) => { if (!found.some((f) => f.key === item.key && f.kind === item.kind)) found.push(item) }
  for (const m of text.matchAll(/https?:\/\/[^\s<>()"'`\]\[]+/g)) {
    const url = trimUrl(m[0])
    // Taken apart by hand: the mod's runtime has no URL.
    const at = /^(https?:\/\/)([^/?#]+)([^?#]*)/.exec(url)
    if (!at) continue
    const u = { origin: `${at[1]}${at[2]}`, host: at[2]!, hostname: at[2]!.replace(/:\d+$/, '').toLowerCase(), pathname: at[3] || '/' }
    const parts = u.pathname.split('/').filter(Boolean)
    if (u.hostname === 'github.com' && parts[2] === 'pull' && /^\d+$/.test(parts[3] ?? '')) {
      const repo = `${parts[0]}/${parts[1]}`
      const number = Number(parts[3])
      add({ kind: 'pull', url: `https://github.com/${repo}/pull/${number}`, key: `${parts[1]}#${number}`, repo, number })
      continue
    }
    if (onlyPulls) continue
    if (/(^|\.)figma\.com$/.test(u.hostname) && ['design', 'file', 'proto', 'board'].includes(parts[0] ?? '') && parts[1]) {
      const name = parts[2] ? safeDecode(parts[2]).replace(/-+/g, ' ').trim() : parts[1]
      add({ kind: 'figma', url, key: name || parts[1] })
      continue
    }
    if (/\.atlassian\.net$/.test(u.hostname) && parts[0] === 'browse' && /^[A-Z][A-Z0-9]+-\d+$/.test(parts[1] ?? '')) {
      add({ kind: 'ticket', url: `${u.origin}/browse/${parts[1]}`, key: parts[1]! })
      continue
    }
    if (/^(localhost|127\.0\.0\.1)$|\.(test|local|localhost)$/.test(u.hostname)) {
      const path = u.pathname.replace(/\/$/, '')
      add({ kind: 'page', url: `${u.origin}${u.pathname}`, key: `${u.host}${path}` })
    }
  }
  return found
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s) } catch { return s }
}

/**
 * What each link's chip says (item 156, design C): its key, with the repo
 * name's shared start (`acme-`) taken off when every pull request has it,
 * so `frontend#2736 · backend#821` rather than the full names.
 */
export function chipLabels(list: readonly Pick<LinkItem, 'kind' | 'key'>[]): string[] {
  const repos = list.filter((l) => l.kind === 'pull').map((l) => l.key.slice(0, l.key.lastIndexOf('#')))
  let common = ''
  // One pull request alone keeps its full name: there is nothing to tell it apart from.
  if (repos.length > 1) {
    const first = repos[0]!
    const dash = first.indexOf('-')
    const prefix = dash > 0 ? first.slice(0, dash + 1) : ''
    if (prefix && repos.every((r) => r.startsWith(prefix) && r.length > prefix.length)) common = prefix
  }
  return list.map((l) => (l.kind === 'pull' && common && l.key.startsWith(common) ? l.key.slice(common.length) : l.key))
}

/** The chips packed into rows of `room` cells, ` · ` between them: the indexes on each row. */
export function packChips(labels: readonly string[], room: number): number[][] {
  const rows: number[][] = []
  let width = 0
  labels.forEach((label, i) => {
    const w = Math.min(label.length, room)
    const row = rows[rows.length - 1]
    if (row && width + 3 + w <= room) {
      row.push(i)
      width += 3 + w
    } else {
      rows.push([i])
      width = w
    }
  })
  return rows
}

/** Most recent first, and no more than this: the pane is for the few in play. */
const LINKS_KEPT = 8

/**
 * Notes the links a text names, newest first, and asks `gh` for the title and
 * state of each new pull request: one small call per pull request the first
 * time it is seen, never while drawing.
 *
 * The goal's own link is listed too, always first (item 166): it is the one
 * you most want to open, and the prompt that named it is where you'd look.
 */
async function noteLinks($: $, text: string, onlyPulls = false) {
  const fresh = findLinks(text, onlyPulls)
  if (fresh.length === 0) return
  const goalKey = await $.env.get('KOVAN_GOAL_KEY')
  const same = (a: Found, b: Found) => a.kind === b.kind && a.key === b.key
  let added: Found[] = []
  await update($, links, (list) => {
    added = fresh.filter((l) => !list.some((p) => same(p, l)))
    const moved = fresh.map((l) => list.find((p) => same(p, l)) ?? l)
    const rest = list.filter((p) => !fresh.some((l) => same(p, l)))
    return goalFirst([...moved, ...rest], goalKey).slice(0, LINKS_KEPT)
  })
  for (const link of added) if (link.kind === 'pull') void describePull($, link).catch(() => undefined)
}

/** The goal's link, when listed, moved to the front; the rest keep their order. */
export function goalFirst<T extends { key: string }>(list: readonly T[], goalKey: string | undefined): T[] {
  const goal = goalKey ? list.find((l) => l.key === goalKey) : undefined
  return goal ? [goal, ...list.filter((l) => l !== goal)] : [...list]
}

async function describePull($: $, link: Found) {
  if (!link.repo || !link.number) return
  const r = await $.process.run(
    ['gh', 'pr', 'view', String(link.number), '--repo', link.repo, '--json', 'title,state,isDraft'],
    { cwd: await $.session.cwd(), timeoutMs: 15_000 }
  )
  if (r.exitCode !== 0) return
  const got = JSON.parse(r.stdout) as { title?: string; state?: string; isDraft?: boolean }
  const state: LinkItem['state'] = got.isDraft && got.state === 'OPEN' ? 'draft'
    : got.state === 'MERGED' ? 'merged' : got.state === 'CLOSED' ? 'closed' : got.state === 'OPEN' ? 'open' : undefined
  await update($, links, (list) => list.map((p) => (p.kind === 'pull' && p.key === link.key
    ? { ...p, ...(got.title ? { title: got.title } : {}), ...(state ? { state } : {}) }
    : p)))
}

/**
 * The links said before the pane loaded: a session that ran a while before
 * this mod (or a reload of it) still lists what its chat named. Read once, at
 * the start, in order, so the newest end up first.
 */
async function readEarlierLinks($: $) {
  const messages = await $.session.messages()
  for (const m of messages) {
    if (m.text) await noteLinks($, m.text)
    for (const r of m.toolResults ?? []) if (r.text) await noteLinks($, r.text, true)
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

/** One part of the usage line: a dim label ('' for none), and its value in its own color (item 151). */
export type UsagePart = { label: string; value: string; color: string }

/** 1.0M as 1M: the short line has no room for a zero. */
function short(n: number): string {
  return tokens(n).replace(/\.0(?=[kM]$)/, '')
}

/**
 * The usage line's parts, short enough for one row of the pane (item 153):
 * `Opus 5.5 · ctx 97k/1M 10% · 5h 19% → 17:00 · wk 40% → Mon · $1.03`. Each value
 * in the color Claude's own status line gives it: model blue, context green,
 * session amber, weekly purple; the cost in Claude's orange. Theme keys, so a light theme gets its own
 * shades.
 */
export function usageParts(u: Usage, now: number): UsagePart[] {
  const parts: UsagePart[] = []
  if (u.model) parts.push({ label: '', value: modelName(u.model), color: 'suggestion' })
  if (u.ctxWindow) {
    parts.push({
      label: 'ctx',
      value: u.ctxTokens !== undefined
        ? `${short(u.ctxTokens)}/${short(u.ctxWindow)} ${u.ctxPercent ?? Math.round((u.ctxTokens / u.ctxWindow) * 100)}%`
        : `0/${short(u.ctxWindow)}`,
      color: 'success'
    })
  }
  for (const [label, w, color] of [['5h', u.session, 'warning'], ['wk', u.weekly, 'merged']] as const) {
    if (!w) continue
    const when = resets(w.resetsAt, now)
    parts.push({ label, value: `${Math.round(w.percent)}%${when ? ` → ${when}` : ''}`, color })
  }
  // Last, in Kovan's own cost color: the first thing to go when the row is short.
  if (u.cost !== undefined) parts.push({ label: '', value: `$${u.cost.toFixed(2)}`, color: 'claude' })
  return parts
}

export function usageLine(u: Usage, now: number): string {
  return usageParts(u, now).map((p) => `${p.label ? `${p.label} ` : ''}${p.value}`).join(' · ')
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
    ...(weekly ? { weekly } : {}),
    ...(u.cost ? { cost: u.cost.usd } : {})
  }))
}

// ── the hooks ──────────────────────────────────────────────────────────────

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'kovan', description: "Open Kovan's pane: the goal, plan, changes, checks and usage" })
    void $.ui.open({ id: PANE, title: 'Kovan' }).then(() => $.ui.open({ id: CHANGES, title: 'Changes' })).catch(() => undefined)
    void refreshUsage($).catch(() => undefined)
    void refreshScripts($).catch(() => undefined)
    void refreshFolders($).catch(() => undefined)
    void readEarlierLinks($).catch(() => undefined)
    void refreshReviewModels($).catch(() => undefined)
    // Reset times count down even while nothing happens.
    $.clock.every(60_000, () => { void refreshUsage($).catch(() => undefined) })
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { sections: [...composed.sections, { id: 'kovan:plan', text: PLAN_NOTE, scope: 'session' as const }] }
  })

  // The prompt Kovan starts the session with counts as the person asking, so
  // the pane opens at any width with nothing to type (item 149). The first
  // prompt only: a pane closed by hand stays closed until /kovan.
  let asked = false
  on('prompt.submit', async ($, e, next) => {
    if (e.text.includes('<task-notification>')) void noteTaskNotices($, e.text).catch(() => undefined)
    else void noteLinks($, e.text).catch(() => undefined)
    if (!asked) {
      asked = true
      void $.ui.open({ id: PANE, title: 'Kovan' }).catch(() => undefined)
    }
    return next(e)
  })

  on('command.run', { command: 'kovan' }, async ($) => {
    await $.ui.open({ id: PANE, title: 'Kovan' })
    await $.ui.open({ id: CHANGES, title: 'Changes' })
    return { text: "Kovan's pane is open." }
  })

  on('tool.call', async ($, e, next) => {
    if (String(e.tool) === 'Bash') {
      try { await startReviews($, String((e as unknown as Record<string, unknown>)['command'] ?? '')) } catch { /* a view only */ }
    }
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
    void noteLinks($, done.text ?? '').catch(() => undefined)
    return done
  })

  // Changes (item 165): every changed file's diff, in every folder of the
  // session, one after another, as Claude Code's Diff tab shows its own folder.
  on('ui.render', { component: 'Pane', requestId: CHANGES }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const cols = Math.max(24, e.props.bodyColumns)
    const [changed, roots, views, openDir] = await Promise.all([read($, files), read($, folders), read($, diffs), $.env.get('KOVAN_OPEN_DIR')])
    // Opened, or a file listed since: fill in what's missing, then draw again.
    if (changed.some((f) => !views[f.path])) void loadAllDiffs($).catch(() => undefined)
    const groups = changeGroups(changed, roots)
    const counts = (list: readonly FileChange[]) => {
      const add = list.reduce((n, f) => n + f.add, 0)
      const del = list.reduce((n, f) => n + f.del, 0)
      return <Text><Text color="diffAdded">{` +${add}`}</Text><Text color="diffRemoved">{` −${del}`}</Text></Text>
    }
    const row = (left: RenderChildren, right: RenderChildren) => (
      <Box flexDirection="row" width={cols}>
        <Box flexGrow={1} flexShrink={1}>{left}</Box>
        <Box flexShrink={0}>{right}</Box>
      </Box>
    )
    const fileBlock = (f: FileChange) => {
      const view = views[f.path]
      return (
        <Box flexDirection="column" width={cols} marginBottom={1}>
          {row(
            <Text bold wrap="truncate-end">{fitPath(f.rel, cols - 14)}</Text>,
            !f.repo ? <Text> </Text> : f.isNew ? <Text color="diffAdded">{` new +${f.add}`}</Text> : counts([f])
          )}
          {!view ? <Text dimColor>  Reading the diff…</Text> : null}
          {view?.text ? <Code source={view.text} format={view.plain ? 'source' : 'diff'} path={f.rel} wrap="truncate-end" /> : null}
          {view?.note ? <Text dimColor>{`  ${view.note}`}</Text> : null}
          {openDir && f.repo
            ? <Box marginLeft={2}><Button key={`changes-kovan:${f.path}`} plain label="Open in Kovan" onPress={() => { void openInKovan($, f.path) }} /></Box>
            : null}
        </Box>
      )
    }
    if (changed.length === 0) return <Text dimColor>No files changed yet in any of this session's folders.</Text>
    return (
      <Box flexDirection="column" width={cols}>
        {groups.repos.filter((g) => g.files.length > 0).map((g) => (
          <Box flexDirection="column" width={cols}>
            {row(<Text bold color="suggestion" wrap="truncate-end">{g.name}</Text>, counts(g.files))}
            <Text> </Text>
            {g.files.map(fileBlock)}
          </Box>
        ))}
        {groups.others.length
          ? (
            <Box flexDirection="column" width={cols}>
              <Text dimColor bold>Other files</Text>
              {groups.others.map(fileBlock)}
            </Box>
          )
          : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code, Link } = $.ui.resolve(e)
    const cols = Math.max(24, e.props.bodyColumns)
    const [goal, goalKey, openDir, steps, changed, openPath, view, ran, u, now, canCheck] = await Promise.all([
      $.env.get('KOVAN_GOAL'), $.env.get('KOVAN_GOAL_KEY'), $.env.get('KOVAN_OPEN_DIR'),
      read($, plan), read($, files), read($, open), read($, diff), read($, checks), read($, usage),
      $.clock.now(), read($, scripts)
    ])
    const linked = await read($, links)
    const labels = chipLabels(linked)
    const reviewRows = reviewList(await reviewNames($), await read($, reviews))
    const modelsOf = await read($, reviewModels)
    const groups = changeGroups(changed, await read($, folders))

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

    const fileRow = (f: FileChange, indent: string) => (
      <Box flexDirection="column" width={cols}>
        {row(
          <Button key={`file:${f.path}`} plain label={`${indent}${openPath === f.path ? '▾' : '▸'} ${fitPath(f.rel, cols - indent.length - 14)}`} onPress={() => { void toggle($, f.path) }} />,
          !f.repo
            ? <Text> </Text>
            : f.isNew
              ? <Text color="diffAdded">{` new +${f.add}`}</Text>
              : <Text><Text color="diffAdded">{` +${f.add}`}</Text><Text color="diffRemoved">{` −${f.del}`}</Text></Text>
        )}
        {openPath === f.path && view.path === f.path && view.text
          ? <Code source={view.text} format={view.plain ? 'source' : 'diff'} path={f.rel} wrap="truncate-end" />
          : null}
        {openPath === f.path && view.path === f.path && view.note ? <Text dimColor>{`  ${view.note}`}</Text> : null}
        {openPath === f.path && openDir && f.repo
          ? <Box marginLeft={2}><Button key={`kovan:${f.path}`} plain label="Open in Kovan" onPress={() => { void openInKovan($, f.path) }} /></Box>
          : null}
      </Box>
    )

    const doing = steps.findIndex((s) => s.status === 'in_progress')
    const nextIdx = steps.findIndex((s, i) => s.status === 'pending' && (doing < 0 || i > doing))
    const done = steps.filter((s) => s.status === 'completed').length
    const added = changed.reduce((n, f) => n + f.add, 0)
    const removed = changed.reduce((n, f) => n + f.del, 0)

    // Docked, the usage line sits on the pane's last row, however little is above it.
    return (
      <Box flexDirection="column" width={cols} minHeight={e.props.placement === 'dock' ? e.props.scroll?.bodyRows : undefined}>
        <Box flexDirection="column" width={cols} flexGrow={1}>
          {goal ? <Text dimColor bold>{`GOAL${goalKey ? ` · ${goalKey}` : ''}`}</Text> : null}
          {goal ? <Text bold wrap="wrap">{goal}</Text> : null}
          {goal ? <Text> </Text> : null}

          {linked.length ? head('LINKS', String(linked.length)) : null}
          {/* Chips, design C (item 156): each a link, a pull request in its state's color. */}
          {packChips(labels, cols).map((rowOf) => (
            <Text>
              {rowOf.map((i, n) => {
                const l = linked[i]!
                const color = l.kind !== 'pull' ? undefined
                  : l.state === 'open' ? 'success' : l.state === 'merged' ? 'merged' : l.state ? 'subtle' : undefined
                return (
                  <Text>
                    {n ? <Text dimColor> · </Text> : null}
                    <Text {...(color ? { color } : {})}><Link href={l.url} label={fitPath(labels[i]!, cols)} /></Text>
                  </Text>
                )
              })}
            </Text>
          ))}
          {linked.length ? <Text> </Text> : null}

          {head('PLAN', steps.length ? `${done} of ${steps.length} done` : '')}
          {steps.length === 0 ? <Text dimColor>No task list yet: the plan shows once Claude keeps one.</Text> : null}
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
          {changed.length === 0 && groups.flat ? <Text dimColor>No files changed yet.</Text> : null}
          {groups.flat
            ? changed.map((f) => fileRow(f, ''))
            : [
                ...groups.repos.map((g) => {
                  const add = g.files.reduce((n, f) => n + f.add, 0)
                  const del = g.files.reduce((n, f) => n + f.del, 0)
                  return (
                    <Box flexDirection="column" width={cols}>
                      {row(
                        <Text bold wrap="truncate-end">{g.name}</Text>,
                        g.files.length ? <Text><Text color="diffAdded">{` +${add}`}</Text><Text color="diffRemoved">{` −${del}`}</Text></Text> : <Text> </Text>
                      )}
                      {g.files.length === 0 ? <Text dimColor>  no changes</Text> : null}
                      {g.files.map((f) => fileRow(f, '  '))}
                    </Box>
                  )
                }),
                groups.others.length
                  ? (
                    <Box flexDirection="column" width={cols}>
                      <Text dimColor bold>Other files</Text>
                      {groups.others.map((f) => fileRow(f, '  '))}
                    </Box>
                  )
                  : null
              ]}
          <Text> </Text>

          {reviewRows.length ? head('REVIEWERS', reviewSummary(reviewRows)) : null}
          {reviewRows.map((r) => {
            const mins = (to: number) => (r.since !== undefined ? Math.max(0, Math.floor((to - r.since) / 60_000)) : 0)
            const look = REVIEW_LOOK[r.state]
            const right = r.state === 'running' ? `running · ${mins(now)}m`
              : r.state === 'waiting' ? 'not run yet'
                : `${look.word}${r.ended ? ` · ${mins(r.ended)}m` : ''}`
            const models = modelLine(r, modelsOf)
            // The name never gives way, as a check's: a long verdict is cut.
            return (
              <Box flexDirection="column" width={cols}>
                <Box flexDirection="row" width={cols}>
                  <Box flexShrink={0}>
                    <Text><Text color={look.color}>{look.mark} </Text><Text dimColor={r.state === 'waiting'}>{r.name}</Text></Text>
                  </Box>
                  <Box flexGrow={1} flexShrink={1} marginLeft={2}>
                    <Text dimColor wrap="truncate-end">{r.detail ?? ''}</Text>
                  </Box>
                  <Box flexShrink={0}>
                    <Text color={r.state === 'waiting' ? undefined : look.color} dimColor={r.state === 'waiting'}>{` ${right}`}</Text>
                  </Box>
                </Box>
                {models ? <Box marginLeft={2}><Text dimColor wrap="truncate-end">{models}</Text></Box> : null}
              </Box>
            )
          })}
          {reviewRows.length ? <Text> </Text> : null}

          {head('CHECKS')}
          {ran.length === 0 ? <Text dimColor>None yet: tests and typechecks show here when they run.</Text> : null}
          {ran.map((c) => (
            // The name never gives way: a long detail is cut, not the check it belongs to.
            <Box flexDirection="row" width={cols}>
              <Box flexShrink={0}>
                <Text><Text color={c.ok === null ? 'subtle' : c.ok ? 'success' : 'error'}>{c.ok === null ? '… ' : '● '}</Text>{c.name}</Text>
              </Box>
              <Box flexGrow={1} flexShrink={1} marginLeft={2}>
                <Text dimColor wrap="truncate-end">{c.detail || (c.ok === null ? 'running…' : c.ok ? 'passed' : 'failed')}</Text>
              </Box>
            </Box>
          ))}
          {canCheck ? <Box marginTop={1}><Button key="run-checks" label="Run checks" onPress={() => { void runChecks($) }} /></Box> : null}
          <Text> </Text>
        </Box>

        <Text wrap="truncate-end">
          {usageParts(u, now).map((p, i) => (
            <Text><Text dimColor>{`${i ? ' · ' : ''}${p.label ? `${p.label} ` : ''}`}</Text><Text color={p.color}>{p.value}</Text></Text>
          ))}
        </Text>
      </Box>
    )
  })
}
