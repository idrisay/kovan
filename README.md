# Baton

Tells you what is blocked on you, and hands it to a coding agent.

A macOS menu bar app. It watches your GitHub pull requests and Jira tickets and
says which of them need work before they can merge — and it does that whether
or not your editor is open, which is the one thing the
[DevHub extension](../devhub) structurally cannot do.

Successor to [`devhub-mac`](../devhub-mac) (Swift). The migration plan and its
reasoning are in [`../devhub-next/MIGRATION.md`](../devhub-next/MIGRATION.md).

---

## Status

Phases 0–3 of the plan are working: the shared packages, the menu bar app, the
poller and the queue views. Verified against a real account — 42 pull requests,
16 blocked, 62 tickets.

| Phase | | |
|---|---|---|
| 0 | Scaffold, naming, workspaces | done |
| 1 | Extract `core` + `providers` behind the `Host` seam | done |
| 2 | Menu bar app: tray, poller in main, notifications | done |
| 3 | Queue and ticket views | done |
| 4 | Terminal + agent runner (`node-pty`, run archive) | done |
| 4b | Detail panes for pull requests and tickets | done |
| 3b | Re-point the VS Code extension at `packages/*` | **not started** |
| 5 | Workbench: explorer, Monaco editor, diff | not started |
| 6 | Workspaces, Activity, Environments, reviewers | not started |
| 7 | Codesign, notarise, auto-update | not started |

Sentry, Grafana and Figma clients are **not** ported yet, though their pure
logic is already in `@baton/core` and `CREDENTIAL_FIELDS` knows about them.

## Getting started

```sh
npm install
npm run import          # move DevHub's tokens, settings and run history across
npm run --workspace @baton/desktop dev
```

`npm run import` is safe to re-run and never deletes anything DevHub owns. Add
`--dry-run` to see what it would do. Expect a Keychain dialog per provider —
that is macOS deciding whether this process may read the secret.

## Layout

```
packages/host        the seam: Secrets, Config, Files, Log. No platform imports.
packages/core        pure domain logic + the agent prompts. Shared with the extension.
packages/providers   GitHub and Jira clients, HTTP, credentials, PR detail.
packages/agent       runner discovery, argv/shell-line building, the run archive.
packages/git         clone discovery, so a run starts in the right folder.
apps/desktop
  src/main           tray, poller, notifications, pty sessions, IPC
                     — all of it works with no window open
  src/preload        contextBridge. Tokens go in, never come out.
  src/renderer       React views
scripts              one-time migration from DevHub
```

## The one architectural rule

**Baton is main-process-first.** The poller, providers, credentials and
notifications live in the main process, and the window is *destroyed* when
closed rather than hidden. The app is fully functional with no window open.

That is the entire reason it beats the extension it replaces. If you move the
poller into the renderer, the app is only alive while a window is — which is
the limitation the project exists to fix.

## Commands

| | |
|---|---|
| `npm test` | unit tests (`vitest`) |
| `npm run typecheck` | packages and app |
| `npm run smoke` | launch, assert main/preload/renderer wiring, exit |
| `npm run --workspace @baton/desktop smoke:seeded` | same, with a fixture snapshot, asserts row and flag rendering |
| `npm run --workspace @baton/desktop smoke:live` | same, against your real accounts |
| `npm run --workspace @baton/desktop smoke:workspace` | drives the explorer against scratch clones: expands the tree, collapses all, opens a diff, edits a file, saves it with ⌘S, forces a save conflict, and removes a folder |

`smoke` exists because screenshots need a screen-recording permission that CI
does not have, and "it rendered" is the assertion that actually matters.

## Running an agent

Pick a pull request or a ticket, and the detail pane offers the run that fits
it: **Work on this in an agent** for a ticket, **Review in an agent** for
somebody else's pull request, **Unblock** and **Check it shipped** for your own.

You see the prompt before it is sent, and can edit it. That is deliberate: the
prompts are long because every line of them is a mistake somebody made once,
and an agent started on a prompt nobody read is how the wrong thing gets built
confidently.

Every run leaves a folder under `runs/<ticket>/<timestamp>/` holding the prompt,
the report the agent writes to `$BATON_REPORT`, and any screenshots it saves in
`$BATON_SHOTS`. One folder per ticket, so the second time a ticket comes round
the first time is already there. `$BATON_TICKET` is everything already known,
written before the agent starts.

### The security rule

The prompt is **never** interpolated into a shell line. Prompts are built from
pull request titles and review comments — text other people wrote — and the
process receiving them has a shell and your credentials. Direct spawns pass it
as one argv element; terminal sessions write it to a 0600 file and reference it
as `"$(< path)"`, which a shell substitutes once and does not re-parse.
`packages/agent/test/runner.test.ts` round-trips a prompt containing backticks,
`$(…)` and `rm -rf` through a real zsh and asserts it arrives byte-identical.

### Which agents it finds

Both the ones on your PATH and the ones that are shell functions or aliases.
`which` cannot see the second kind — they are lines in a `.zshrc` — and on a
real machine that is about half of them.

## The workspace

A workspace is a **set of folders**, like VS Code's multi-root workspaces, and
every one of them is on screen at once. The explorer is headed by the workspace
itself — `acme (Workspace)`, `4 folders` — with its folders beneath.

**There is no workspace dropdown.** There was, and it was wrong: a control
whose job is to show one workspace at a time becomes a *repository* switcher
the moment somebody makes one workspace per repo, which is exactly what
happened. Switching moved into the overflow menu, where something you do rarely
belongs.

**Add a folder** with the button on the workspace row. **Remove one** with the
× that appears on a folder row on hover — it stops listing the folder and
touches nothing on disk, which is why it needs no confirmation and why every
label says *remove from workspace*.

**A repository is a row, not a section.** Eight repos of header + changes +
tree do not fit on a screen; eight rows do. Each carries its branch, its
ahead/behind, and a count of what has changed. A folder that is not itself a
clone shows the clones found inside it.

**Files and Changes are separate tabs.** Stacked in one scroller, a repo with
twenty changes pushed the tree below the fold, so a workspace looked like it
had no folders in it.

**Collapse all** is top right. It closes every folder *and* every repository,
so the press always lands on the same thing: the list of repositories in this
workspace.

Changes come from `git status --porcelain=v2`, grouped as git groups them —
staged, changed, untracked. Clicking one opens a unified diff with both line
numbers. The staged and unstaged diff of one file are two different things, so
they are two tabs.

### Editing

Files open in a real editor — CodeMirror 6, with multi-cursor, undo, bracket
matching and find. ⌘S saves. An unsaved tab shows a clay dot **in place of**
its close button, so the muscle memory that shuts a saved tab cannot discard an
edit.

Three things guard the write, and each has a test:

- **The path is resolved against the workspace folders first**, exactly as
  reads are. A symlink planted inside a workspace that points out of one is
  refused, and so is a path that climbs out with `..`.
- **A save is refused if the file moved under it.** An agent running in the
  same clone edits the same files; the mtime and size recorded at open are
  compared at save, and a mismatch offers *Reload from disk* or *Keep mine*
  rather than silently overwriting the agent's work.
- **Writes are atomic.** The bytes go to a temp file in the same directory and
  are renamed over the target, so a crash mid-write cannot leave an empty file
  where your source was. The original permission bits are carried over —
  writing 0644 over a script silently un-executes it.

What it still does not do: stage, commit, rename, delete, create, or watch the
filesystem. Refresh is a button.

- **A directory is listed only when it is opened**, so a workspace pointed at a
  folder full of `node_modules` opens as fast as an empty one. Expansion state
  and loaded entries live on the workspace view, not in each level of the tree,
  so collapsing a folder no longer discards everything beneath it.

### Why every path is re-resolved

The renderer displays pull request bodies and ticket descriptions — other
people's text. So no IPC channel reads a path it was handed. Each one resolves
it first against the workspace folders: `realpath` on both sides, so a symlink
planted inside a workspace cannot point out of one, and a separator required
after the root, so `~/work-secrets` is not accepted as living under `~/work`. A
path that fails is refused, not clamped.

### Syntax highlighting

One highlighter, not two. The editor needs CodeMirror, which brings its own
grammars, so the diff uses them as well rather than shipping highlight.js
alongside: `highlightLines` renders a static string through Lezer's
`highlightCode`, and the same grammar drives the live editor. Colours are
Lezer's `tok-*` classes styled in `styles.css`, beside the rest of the design.

Detection is by extension, never auto-detected — guessing from content reads a
three-line shell script as Perl, which looks like a rendering bug.

**This cost bundle size, measured rather than estimated**: 1,134 kB before,
2,484 kB after. CodeMirror core is 1,511 kB of that and the 26 grammars are
973 kB. It loads from disk rather than the network, so the cost is parse time,
not download — but the grammars are the obvious thing to load on demand if it
starts to show.

## Known gaps

- **Idle memory is ~244 MB**, against the Swift app's few MB. Measured, not
  estimated; see MIGRATION.md §9 for the breakdown and what was tried.
- `noUncheckedIndexedAccess` is off, matching the extension's original compiler
  contract. Turning it on means auditing ~17 regex `match[1]` sites.
- Queue scoping is account-wide only. The clone index that folder and workspace
  scoping needs now exists in `@baton/git`; wiring it to the queue does not.
- The workspace cannot stage, commit, rename, delete or create files.
- `smoke:workspace` needs `BATON_USER_DATA` and `BATON_WS_FOLDER` set. The
  first is not optional — seeding a workspace into the real profile would leave
  a folder in your app that you never chose, and the seeder refuses without it.
  It **edits and saves a real file**, so point `BATON_WS_FOLDER` at scratch
  clones, never at a repository you care about. `BATON_WS_FOLDER` is
  colon-separated, because the multi-folder workspace is the case worth
  exercising.

## Installing

```sh
npm run install:app --workspace @baton/desktop
```

Builds, copies to `/Applications/Baton.app`, re-signs and launches it. Re-run it
to update — it quits the running copy first, because swapping the bundle under a
live process leaves it running old code from a deleted inode.

Baton is **ad-hoc signed**. That is fine for a local install (Gatekeeper only
quarantines what was downloaded) but it is not distributable: sending the
bundle to another Mac needs the Developer ID and notarisation of Phase 7.

Only one Baton runs at a time — a single-instance lock means a `dev` build
exits immediately while the installed one is running. Quit it from the menu bar
first.

### Open at login

On by default, toggled from the tray menu. The login item is re-asserted on
every launch, because it registers against a bundle path and reinstalling
elsewhere would otherwise orphan it silently.

## Design

The interface follows the DevHub design canvas — its surfaces, type scale,
status palette and layout, in both themes. The canvas is the source; this is
the implementation.

Six rules from it, which `src/renderer/styles.css` exists to hold:

1. **Elevation separates.** Rail → sidebar → editor → card, each a step
   brighter. The surface you *read* on is the brightest; everything you
   *operate* sits a step back. In light mode the values invert but the rule
   does not.
2. **Clay is reserved** — selection, the primary action, a link. Never
   decoration, so a coloured thing on screen always means something.
3. **Red only ever means something failed.** Queue rows are grouped and only
   the blocked group is tinted, which is why "blocked on you" is a section of
   one list rather than a view of its own: a whole screen of red says nothing.
4. **Hairlines at 6–9%.** No heavy dividers, no boxes around boxes.
5. **Anything a machine wrote is mono** — a path, a number, a sha, a duration.
6. **Status is a dot plus a word**, so it survives being read in grey.

Prose is capped at a 720px measure wherever it appears. Type is IBM Plex Sans
for prose, IBM Plex Mono for machine text, Space Grotesk for titles — bundled
via `@fontsource`, not fetched, because the app has to work offline and the
renderer's CSP allows no remote origins.

Markdown from pull requests and tickets is rendered through `marked` and
sanitised with DOMPurify before it reaches the DOM. That is not a formality:
it is other people's text inside a renderer that holds a bridge to the main
process.

### Checking it

```sh
BATON_SMOKE=live BATON_SHOT=/tmp/q.png BATON_SHOT_DETAIL=/tmp/d.png \
  npm run --workspace @baton/desktop start
```

`BATON_THEME=light` forces the appearance so both can be captured without
touching System Settings. The smoke harness waits for the UI to be *ready*
rather than for a fixed delay — a fixed wait landed on the boundary where live
data arrives, and different assertions in one run saw different states.
