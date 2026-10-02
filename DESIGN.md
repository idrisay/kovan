# Kovan design patterns

How Kovan looks, behaves and is built. Follow this when adding a feature or
changing one. If a change needs to break a rule here, change the rule here in
the same commit and say why.

The visual tokens live in `apps/desktop/src/renderer/styles.css`. This file
explains how to use them and adds the behaviour and code rules that CSS
can't express.

---

## 1. Visual language

### The six rules (from the top of `styles.css`)

1. **Elevation separates things.** Rail → sidebar → editor → card, each a step
   brighter. The surface you *read* on is the brightest, and what you
   *operate* sits a step back. Don't add borders or boxes to separate areas;
   use the next surface token.
2. **Clay (`--clay`) is reserved** for selection, the primary action and links.
   Never use it as decoration. If something is clay, it can be clicked or is
   selected.
3. **Red only means something failed** (`--blocked`, `--blocked-bright`). A
   destructive *warning* is not a failure: use amber (`--running`) for "are
   you sure", like the session close's confirmation.
4. **Hairlines at 6–9%** (`--hair`, `--hair-strong`). No heavy dividers, no box
   inside a box.
5. **Anything a machine wrote is mono** (`--mono`): paths, SHAs, keys, model
   names, durations, ages, costs.
6. **Status is a dot plus a word** (`.dot.pass|running|fail|waiting|merged|live`),
   so it still reads in greyscale. When space is short, the word moves to the
   tooltip, but it never disappears.

### Tokens

| Group | Tokens | Use |
|---|---|---|
| Surfaces | `--rail` `--sidebar` `--editor` `--card` | Elevation, in that order |
| Text | `--title` `--strong` `--body` `--prose` `--secondary` `--meta` `--muted` `--dim` | Brightest to dimmest. Headings `--title`, reading `--prose`, labels `--meta`, placeholders and ages `--dim` |
| Accent | `--clay` `--clay-bright` | Rule 2 |
| Status | `--pass` `--running` `--blocked` `--waiting` `--merged` | Only for state |
| Lines | `--hair` `--hair-strong` `--wash` | Rule 4 |
| Type | `--sans` (IBM Plex Sans) · `--mono` (IBM Plex Mono) · `--display` (Space Grotesk) | Display only for pane and sheet titles |
| Measure | `--measure` 720px · `--column` 1040px · `--page` 1480px | Prose never runs wider than `--measure` |

Every colour needs a value in both themes. Dark is `:root`, light is
`:root[data-theme='light']`. A new literal colour needs a light override next
to it, or it must be a token. A tint of the accent or a status is
`color-mix(in srgb, var(--clay) 14%, transparent)`, never a literal `rgba()`:
the accent and the status colours change with the theme, the accent choice and
colour-safe status, and a literal would not follow them.

### Themes and appearance (item 96)

Seven themes (`packages/core/src/appearance.ts`): Dark, Light, OLED Black,
Cool Graphite, Ember Low Light, High Contrast, Paper Soft. Each is a *tone*
(light or dark → `data-theme`, so every light rule still applies) plus a
*palette* (`data-palette`) that only swaps tokens. The choice is one theme,
Match macOS (a day and a night theme), or a schedule — which switches only
while Kovan is not in front, or when it comes back, never under a reader.
On top of any theme: `data-accent` (curated; ones near a status colour are
marked, macOS arrives as an inline `--clay`), `data-status='safe'`,
`data-shapes` (a glyph per status dot, on by default and always in High
Contrast), `data-density='compact'`. All of it is painted by
`renderer/appearance.tsx`; nothing else writes those attributes. A new theme
needs a palette block in `styles.css`, a `THEMES` entry, and must keep the
elevation order. Fonts are bundled (`@fontsource`); the renderer
never fetches anything remote.

### Type scale

Pane title 15px `--display` 600 · body 12.5–13px · controls 12px ·
meta, ages and chips 10.5–11.5px (mono for machine text) ·
uppercase section labels 10.5px, 600, letter-spaced.

---

## 2. Components

Reuse these before writing new CSS. A new component goes in this list.

### Buttons: three weights, by what the action does

| Class | Meaning | Example |
|---|---|---|
| `.primary` | Starts an agent that **writes** (changes code, opens a PR) | Unblock in an agent, Work on this |
| `.primary.outline` | Starts an agent that only **reads and reports** | Check it shipped, Review |
| `.quick` (dashed blue) | Not an agent: a quick model turning text Kovan already has into shorter text | Summarize, nv-review |
| `.ghost` | Everything else: secondary actions, Settings actions | Add a row |
| `.detail-place` | Where the item lives elsewhere, in a detail header's link row beside the related chips | GitHub / Jira / Sentry (with its mark), Terminal |
| `.link` | Inline, low-weight action inside text or a table row | Remove, Reset, Cancel, Save as default |
| `.icon-button` | Icon-only, borderless. Needs `aria-label` **and** `title` | Row actions, rename |
| `.icon-button.boxed` | Icon-only with a box, for a header's own control | Close ✕ on sheets and terminals |

Icons are Lucide's drawings (item 128), kept inline in `icons.tsx` at a
1.6 stroke so they take `currentColor`. A new icon is copied from
lucide-static's SVG, not drawn by hand. GitHub, Jira and Sentry keep their
own marks, all in the same grey (`currentColor`, item 136). The terminal keeps
Kovan's unboxed `>_` (item 132), and the stop square in Quick model jobs stays
solid.

Put at most one `.primary` in a row. Separate groups of different weights with
the existing vertical rule, not with space alone. A detail header's action bar
holds only what Kovan does — agent runs, then quick model reads; opening the
item on its service, or a terminal for it, goes in the link row above
(`RelatedLinks` `places`, item 110), which keeps the bar on one line.

Quick model buttons are opt-in (item 124): Summarize and Review start hidden,
Condense starts shown, and Settings › Agents › "Buttons on pull requests and
tickets" turns each on or off (`renderer/quickButtons.ts`). Off hides the
button and its card, and an agent run stops using what it made; its setup is
kept. A new optional button joins `QUICK_BUTTONS` instead of getting its own
setting, and the rule before it shows only when something follows it.

### Surfaces and containers

- **Sheet** (`.sheet-backdrop` > `.sheet`): modal for settings, run setup and the
  run viewer. The header is `.sheet-head` with an `h2` and a **boxed ✕ close**,
  never a "Done" button. Clicking the backdrop closes it too. A sheet opened
  from inside a pane is portalled to `<body>` (`createPortal`, as
  `RunViewer` does): `.pane` is a CSS container, which traps anything
  `position: fixed` inside it — the backdrop then covers only the pane and a
  docked terminal paints over it (item 98). No z-index fixes that. A ticket's
  or pull request's `.detail-scroll` is a container too (named `pane`, so the
  layout answers to the ticket's own width beside a docked terminal, item
  139), and traps the same way.
- **Menu** (`.menu`): drop-down from a button. Every menu uses
  `useMenuDismiss` (`menuDismiss.ts`): it closes on an outside click, on
  Escape, and when another menu opens, so two are never open at once. Rows
  are `role="menuitem"`. Use it for sort, filter, refresh and model pickers.
  A menu near the window's right edge opens leftward.
- **Sidebar** (`aside.queue` + `<Resizer />` + `main.pane`): every rail view has
  this shape. The width comes from `--queue-w` and the text size from
  `--sidebar-zoom`. Clicking the active rail icon hides it.
- **Rows** (`.row`, `.row.one-line`): list items. Actions that aren't always
  needed (rename, open, close) are **hover-revealed and take no space until
  hover** (`display: none` → `grid` on `:hover` / `:focus-within`), so names
  aren't truncated. The row is already as tall as those icons (20px), so a
  hover never changes its height and the list never jumps.
- **Reorderable lists** (Sessions, the Workspace's folders, the rail's tabs): drag a row within
  the list; a straight clay line between rows shows where it lands and the
  dragged row dims; ⌥↑ / ⌥↓ does the same from the keyboard. Sessions keep
  the order as a per-window preference (localStorage) and new ones arrive on
  top. A workspace's folder order is part of the workspace (`folders`),
  stored by main, which only accepts a reordering of the same folders
  (`isReordering` in core). A drag never also clicks the row it started on.
  The rail's order is a per-window preference too (`railOrder.ts`, Settings
  pinned below it); `reconcileOrder` in core keeps a saved order valid when a
  tab is added or removed, placing a new one beside its default neighbour.
- **Settings** (`Settings.tsx`, item 99): one list, no side nav. A search
  field, then seven rows — Appearance, Text & terminal, Notifications,
  Dictation, Agents, Connections, Environments — each saying its current
  values in one line. A row opens in place and closes the one that was open;
  its body mounts only then, so opening Settings loads nothing. Search matches
  section names and `SEARCH_INDEX` (every control's label, plus words people
  use); matching rows show the settings that matched as chips, and a chip
  opens the section at that control. A new setting goes into a section and
  its label into `SEARCH_INDEX`, and a section's summary says its value if
  it's one people check.
- **Settings sections**: an `h3`, a `.settings-note` explaining what it does in
  plain words, then controls. Steppers use `.font-size-control`.
- **Split quick button** (`.quick-split`): the label half runs the action, and
  the tag half shows the model plus FREE or `$in/$out`, and opens a provider and
  model picker. Any action that runs a model names that model on its button.
- **Free text in a picker**: a "Type another model…" row that turns into a
  field with a labelled button, never a bare field sitting at the bottom.
- **Agent report card** (`AgentReport`): the latest finished agent run's
  report at the top of its pull request and ticket (verdict badge, Copy, open
  with screenshots, folded when long). A run's result is never only in History.
- **Linked pull requests** (`TicketPulls`): one line each under a ticket's
  title, state first; a click opens the pull request in Kovan, not on GitHub.
- **Result cards** (`QuickCard`): model, age, **Copy** (the Markdown source),
  Refresh and × stay on one line; the model name gives way first.
  Clicking the title (`CardTitle`) folds the card to its head; folds are
  remembered per card and per PR or ticket (`useFold` in `folds.ts`).
- **Headline state**: a detail pane's pill says the most important state; the
  line under it lists the others and never repeats the pill.
- **Repository rows** (Workspace): chevron, `owner/` dimmed then the
  repository's name, then the branch in mono. Every name starts at the same
  x; the branch truncates before the name does. State on the right is a count
  pill when there are uncommitted changes, otherwise a green dot with "Clean"
  in its tooltip. Terminal and remove are hover-revealed like other rows.
- **Kept-alive views** (`.keep-alive`): the Workspace view is mounted on its
  first visit and only hidden after that, so leaving and coming back keeps
  the Files/Changes tab, open repositories, editor tabs and unsaved edits.
  Coming back re-reads git status only.
- **Diff view** (`Diff`): the head has +/− counts, a **Whole file** toggle
  (remembered) and **Open file**. An empty diff says it's empty *now*, why
  that happens, and refreshes the list beside it.
- **Editor change bars** (`Editor`, `changeMarks` in core): VS Code's quick
  diff in the gutter against git's copy — green added, blue changed, a red
  notch where lines were removed — and a count in the status bar. Bars move
  with your typing and are re-read after each save.
- **Open tabs follow git and the disk.** The workspace bumps a revision each
  time it re-reads git status (Refresh, coming back to the view, window
  focus, clicking an already-open change, a revert). The open diff re-reads
  itself; an editor with no edits of its own reloads from disk, and one with
  edits shows the "changed on disk" bar instead. Nothing watches the
  filesystem.
- **Screenshot lightbox** (`RunViewer`): the picture takes the room, with a
  caption bar under it — file name, "Taken <date, time>" (the file's own
  time), "3 of 8", the keys, **Show in Finder** and ✕. ← → (and ↑ ↓, Space)
  move, Home / End jump, Esc closes only the lightbox; the keys are caught on
  the window in the capture phase so a focused terminal can't swallow them.
  Thumbnails carry their name and time. "in Finder" always means revealed in
  Finder (`runReveal`, run files only), never opened in another app.
- **Quick commands** (`QuickCommands.tsx`, `main/quickCommands.ts`, core
  `quickCommands.ts`, item 91): a split button in the title bar — ▶ runs the
  last one, ⌄ opens the menu (search with ↑↓/↩, rows of name + command in
  mono, duplicate/edit/delete on hover only, an inline editor, "+ Command").
  Stored and validated by main; the page asks to run one **by id** and never
  sends a command line. Each runs in its own session, named after it. Running
  one whose terminal is open: still busy (node-pty's foreground process isn't
  the shell) → go to it, never a second dev server; back at its prompt →
  typed again in that same terminal. Delete asks inline, in amber. The menu
  lives in the title bar's drag region, so it and everything in it is
  `no-drag`; and `.menu button` flattens buttons into rows, so real buttons
  inside a menu need their look restored.
- **Live run viewer** (`RunViewer` + `main/runWatch.ts`, item 90): while a
  run's viewer is open its folder is watched (run folders only), and new or
  rewritten files are fetched as they land — never the whole folder again.
  While its agent's session is running the viewer says **Live** (dot plus
  word) and leads with **Now**: the newest screenshot large, "taken 12 s ago",
  and the one-line step the agent writes to `$KOVAN_STATUS` (`status.txt`,
  never listed as a file). New thumbnails get a brief ring in the live green,
  not clay. A running agent's **watch** link (a PR's or ticket's Sessions) opens
  it; the viewer is rendered in the same place whether or not the list still
  shows the session, so the run ending never remounts it.
- **Open in browser** (item 90): the run viewer offers the run's own site —
  read by main from `run.json`, http(s) only, never a URL from the page — and
  the run sheet's environment picker offers the URL in its field. Kovan never
  embeds a web page (see `notes/browser-preview-report.md` for why).
- **Group actions** (Revert all) sit in the group's own header as an icon,
  not on a line of their own.
- **Job rows** (`QuickJobRow`): running is an amber pulsing dot and a live
  timer; finished work is dimmed like merged history and shows its age.
  Actions replace the state word on hover.
- **Picker input** (`.reviewer-picker`): a text field with a `.menu` under it,
  loaded on first focus, most-used entries first, grouped with `.menu-head`.
- **Model field** (`ModelField` in `RunSheet.tsx`): a dropdown with "Type
  another model…" as its last entry, a boxed ↻ that looks up current names
  (tagged "new"), and one line of state under it.
- **Collapsible section** (`DescriptionSection` in `Detail.tsx`): the
  uppercase heading becomes the button, with its chevron hanging in the
  gutter so the label stays aligned with the column. Folded state is
  remembered per PR or ticket, not globally.
- **Multi-choice field** (`FolderField`): a select-looking button opening a
  checklist. When one choice is special, it's labelled in the row
  ("starts here").
- **Pull request rows** (`PullRow`): number and title, then the state words
  on the second line and, beside the age, the repository's name without its
  owner (`RepoLabel`, mono, full `owner/name` in the tooltip). The repo gives
  way before the state does. A pull request with nothing to report says
  **Open** with a grey dot rather than leaving the line empty. Any label a
  word can't explain carries a `hint` from core, shown as its tooltip
  ("2 unresolved comments" says which comments).
- **Activity inbox** (`Activity.tsx`, `main/activityFeed.ts`, `diffActivity`
  in core): a rail tab (bell) listing what happened to you — review
  requested, approved, changes requested, new ticket, new comment — grouped
  Today / Yesterday / Earlier, unread first in weight, read dimmed. The unread
  count sits on the bell in the "waiting" blue (a state, so not clay). A click
  opens the pull request or ticket in the pane beside the list, and reads it.
  Detection is in main and compares each poll with the last; a provider that
  didn't answer is never compared, and more than `FLOOD` of one kind at once
  re-baselines instead of reporting. Each kind can be turned off in Settings.
- **Toasts** (`ActivityToasts`): new activity while the window is in front —
  bottom right, newest on top, at most three plus "+N more in Activity",
  gone after 8 s unless hovered. ✕ dismisses the toast only; the event stays
  unread in the inbox. They sit over panes but under sheets (z 8): a toast
  must never cover a form. When the window isn't in front, the same event is
  a macOS notification instead (never both, and never during a smoke run).
- **Dictation** (`Dictation.tsx`, `main/dictation.ts`, `native/dictate`):
  double-tap ⌘ (⌘ alone, twice, quickly — `DoubleTap` in core, so ⌘C and
  friends never start it), speak, double-tap ⌘ again. A pill bottom-centre
  shows the live words, a level meter in amber (running, not red), where the
  text will go and the language (`· online` when it isn't on-device). The
  target is fixed at the start: a terminal gets it typed and **never** gets
  Enter; a field or editor gets it at the caret through `insertText` so ⌘Z
  undoes it; nothing focused means the clipboard, said in the pill. Nothing
  is inserted until you finish. Esc cancels, and only cancels. A text field
  that deserves a mic gets `DictateButton` (the run sheet's prompt has one),
  with `htmlFor` on its label so the button isn't what the label activates.
  The recogniser is Apple's, on-device where the language allows, in the
  `kovan-dictate` Swift helper (Chromium's speech API doesn't work in
  Electron); it exits on stdin EOF, so the mic can't outlive Kovan.
  Settings › Dictation picks the speech model (item 97, VoiceSmith's list):
  Apple Speech (default, live), whisper.cpp (local `whisper-cli`, models
  from Kovan's and VoiceSmith's folders, or a whisper-server URL), OpenAI,
  Groq, Deepgram, AssemblyAI. For all but Apple the helper runs with
  `--record` (16 kHz mono WAV, mic permission only), `main/transcribe.ts`
  sends it once you finish — the pill says "Transcribing with …" — and the
  recording is deleted whatever happens. Keys are secrets, never settings,
  and never sent back to the renderer. Each provider has a Test that
  transcribes a sample spoken by `say`, so a bad key shows up in Settings.
- **Error card** (`ErrorBoundary`): what a pane shows instead of itself when
  it throws — a red dot (a crash is a failure), what broke in mono, then
  **Try again**, **Show log in Finder** and **Copy details**. Every detail pane
  sits inside one, keyed by what's selected, so picking another row recovers;
  a last-resort one wraps the whole window. Never let a render error reach
  the root: without a boundary React unmounts everything and the window goes
  black.

Form controls inside a `.menu` aren't styled by the sheet rules. Give them
the shared control look explicitly, and scope sheet-wide rules such as
`.run-controls input` so they don't reach checkboxes.

### Text size

There are three independent sizes, each remembered in localStorage: terminal
font (px), reading pane (`--reading-zoom`) and sidebar (`--sidebar-zoom`).
⌘+ and ⌘− change whichever region was last clicked (`zoomTarget.ts`). A new
region that wants its own size gets a `Scale` in `readingSize.tsx` and a
branch in `zoomTarget.ts`. It doesn't get a new keyboard shortcut.

### Terminals

A terminal's row and tab show the title its program sets (Claude Code's task,
as a VS Code tab does), and fall back to the name it was opened with; renaming
by hand wins over both. Dropping a file, or pasting a copied file or a
screenshot, types its path (`shellPath`), which is how Claude Code takes an
image. The Sessions split layout is kept across tabs and window reopenings.
Terminal colours are read from the painted tokens (`terminalTheme()` in
`Terminal.tsx`) and re-applied live on any appearance change; Boosted lifts
them toward full contrast.

**Sessions outlive Kovan (item 114).** Every pty lives in the terminal host
(`main/ptyHost.ts`, built as `ptyHost.mjs` and unpacked from the archive). It
is the app binary in Node mode, started detached, one per build, and it talks
to Kovan over a Unix socket in `$TMPDIR` (`main/ptyClient.ts`). On start,
`Sessions.restore()` picks up every host of this profile. On quit,
`detachAll()` leaves them running; only `close()` ends a session. The host
keeps each session's `SessionInfo` (sent on every change), the tail of its
output and whether it runs, and exits once it is unwatched and empty. The
host protocol only ever grows optional fields, since an older host serves its
sessions across an update. When no host can start, sessions run in-process
as before, and quitting asks first again for those. A smoke run exits
through `app.exit`, which skips `will-quit`, so `index.ts` calls `disposeAll()`
first.

**Agent status (item 112).** Agents Kovan starts report Working / Input /
Done themselves (`main/agentStatus.ts`), and Kovan never guesses it from
output:
- Claude: hooks in the `--settings` it already gets.
- Codex: `notify`, chained to your own; its bell mid-turn means Input.
- OpenCode: a plugin through `OPENCODE_CONFIG_CONTENT`.

Each writes one word to `userData/status/<KOVAN_SESSION_ID>`, and Kovan
watches that folder. The badge is `.session-state` (not `.agent-state`, which
is Agents › Running's). Done hides once the session has been on screen
(`useSeenStatus`); Input stays until answered.

**Hover card (item 115).** A session or Quick model row shows `HoverCard`
(`sessionCard.tsx`) after 500 ms: the subject from the loaded snapshot, never
fetched, then the session. It is portalled like every popover over the
sidebar, and it replaces the row's `title`.

**Shell for new terminals (item 126).** Sessions' + menu opens with a shell
switch (`ShellSwitch` in `App.tsx`). The first three shells are a click away,
and the rest of `/etc/shells` sits behind More…. The choice is the
`terminal.shell` setting (`renderer/shellChoice.ts`), which Settings › Text &
terminal also edits. Main lists only installed shells (`main/shells.ts`), with
the login shell first and named plainly. It spawns only a listed path, and
anything else falls back to the login shell. Only `kovan:open-terminal` uses
the choice. Agents and quick commands keep the login shell. A session in
another shell records it in `SessionInfo.shell`, so its row shows a small tag
and its hover card shows the path.

### Search everything (item 127)

The box in the middle of the title bar (`Search.tsx`) finds pull requests,
tickets, Sentry issues, sessions, files and app actions. ⌘K or a click opens
it in place. ⇥ / ⇧⇥ step through the scope chips, and `>` searches actions
only. It searches only what is loaded: the snapshot, the sessions and ⌘P's
file list, which is asked for each time it opens. It never queries a service
as you type. Matching lives in `searchEverything.ts`. Words match in any
order, and files match fuzzily as ⌘P does. With nothing typed it shows what
is blocked on you or awaiting your review, running sessions, recent files and
the "in an agent" action for what is open. ⌘P stays the file picker. Its
classes are `tsearch-*`, because `.search` is the sidebar's filter box.

### Keyboard

**Back / Forward (item 116).** The ← → arrows in the title bar, and ⌘[ / ⌘]
(except in the code editor) and the mouse's side buttons, walk
`navHistory.ts`. A step is a `Place`: view + subject (+ session on Sessions).
A view opened and then picked in is one step (`placeRefines`). Going back
changes only the state that makes up the place, so no "restoring" flag is
needed. A new kind of place goes into `Place` and `goTo`, not into its own
history.

**Detail header (item 118).** A pull request, ticket and Sentry issue build one
`HeadParts` (crumb, key, status, title, meta, chips, service, terminal,
actions, below) and draw it two ways by density:
- Comfortable: `DetailToolbar`, which is sticky inside `.detail-scroll` and
  outside the reading column's padding, with the actions as one group that
  wraps whole, and then `DetailHead` (title plus a pill-and-details line).
- Compact: `DetailHead compact`, two lines and no toolbar.

Chips always open the item in Kovan, and in the service when it isn't loaded.
A new header item goes into `HeadParts`, not into one pane.

**Connection problems (item 120).** There is no error strip.
- `ProblemLog` (main) folds every finished refresh into `trackProblems` (core): it opens, counts and clears problems, per service.
- `describeProblem` turns raw errors into words. A new kind of failure goes there, with a test.
- The status bar's service names are buttons that open `ProblemsPopover` (Now with Retry and Copy details, then Earlier). A failing one is `.statusbar-item.problem`.
- `ProblemToast` says it once when a problem starts.

**Jira in Activity (item 119).**
- Mentions are found by account id (`mentionsIn`), never by name, from the tickets updated since the last check in your projects (`JiraClient.mentionsSince`).
- The poller also asks who assigned newly listed tickets (`assignedBy`).
- Both ride on the snapshot (`jiraMentions`, `jiraAssignedBy`) into `diffActivity`, which baselines the first read like everything else.
- A mention entry carries an `excerpt`, shown in its row, its toast and its notification.

**Big sheets fold (item 117).** Long, rarely changed parts of a sheet start
folded, with a link saying what's hidden ("Show all 112 lines",
"Change"). The run sheet's prompt, its test accounts and its plan limits
(`AgentLimitsNote compact`) work this way.

⌘F focuses the sidebar filter (except inside the code editor). ⌘P opens
go-to-file (`QuickOpen.tsx`, item 100) from anywhere: recent files first
(`rememberFile` records every file opened, however), fuzzy matching over the
active workspace's files (`main/fileIndex.ts` — `git ls-files` inside a repo,
listed on the first ⌘P, never before), `name:42` for a line; the file opens
in the Workspace view. ⌘+ and ⌘−
resize as above. Every icon-only control is reachable by Tab and has a
visible focus state.

---

## 3. Behaviour rules

1. **Nothing expensive starts by itself.** Opening a pane, a tab or the app
   never runs an agent, a model or a paid API call. The user clicks. Polling
   GitHub, Jira and Sentry is the only exception.
2. **Money is visible before it's spent.** Anything that runs a model shows
   FREE or a cost (`.tag`, usage chips) and names the model.
3. **AI output is a proposal.** When a model produces data that would change
   settings or code (prices, reviews, model lists), show it next to the current
   value with a tick per row. Apply only what's ticked. Example: *Check prices
   online*.
4. **Destructive actions are conservative.** Closing a running session, stopping
   an agent or deleting a stored password asks first, in a small popover by
   the control (`.menu.confirm`) that says what will stop, with focus on
   Cancel. Don't use arm-then-confirm (first click arms, second acts): it read
   as a button that doesn't work on the first click. An idle or finished
   thing can go on one click. Deleting data goes to the Trash when it's a file.
5. **State names what the user recognises.** "Waiting for you", "Checks again
   every minute", "Updated at 14:32". Ages under a minute get seconds, and
   anything relative has the absolute time in its tooltip.
6. **Remember the last choice** (runner, model, environment, dock position,
   sizes), per thing, not globally, when the thing differs.
7. **Kovan is a normal Dock app** with a menu bar glyph as well. Opening
   it, clicking its Dock icon or Cmd+Tabbing to it shows the window; closing
   the window keeps it running. Quitting leaves the sessions running in the
   terminal host (item 114); it asks first only for sessions that run inside
   Kovan because no host could start.
   Right-clicking the Dock icon lists the workspaces, with the active one
   ticked, then the active workspace's folders, the way VS Code lists recent
   folders (item 135, `main/dockMenu.ts`). A pick opens the Workspace view on
   it. The menu is rebuilt when the `workspaces` or `workspace.active`
   settings change. A pick made while no window is open waits in main until
   the new window asks for it.
8. **Everything in the main process keeps working with no window open.**
   Poller, sessions, quick jobs and notifications live in `src/main`. The
   renderer only asks and listens.

---

## 4. Code patterns

### Where things go

| Kind of code | Home |
|---|---|
| Pure logic, prompts, parsing, formatting | `packages/core` (no Node imports in the barrel, since the renderer loads it) **with a test** in `packages/core/test` |
| Running CLIs, shell, PATH, run archive | `packages/agent` |
| GitHub, Jira and Sentry clients | `packages/providers` |
| Processes, files, Keychain, IPC handlers | `apps/desktop/src/main` |
| UI | `apps/desktop/src/renderer`, one component file per feature |

A new IPC channel touches four places: the handler in `main/index.ts`, the
bridge in `preload/index.ts`, the type in `renderer/types.ts`, and the
renderer call. Name it `kovan:<noun>-<verb>`.

### The log

Everything `host.log` writes, anything that throws in main, the window's
process going away, and every error in the window (render errors with their
component stack, uncaught errors, unhandled rejections) goes to
`~/Library/Logs/Kovan/kovan.log` (`main/logFile.ts`), rolled to `kovan.1.log`
at 1 MB. A smoke run with `KOVAN_USER_DATA` logs under that folder instead.
When something breaks, read the log before guessing. Take the headline flag
with `primaryFlag(pull)`, never `pullFlags(pull)[0]!`: a pull request can
have no flags at all.

### The old name (item 121)

The app was called Baton until 2026-09-30. `main/renamed.ts` carries that
state over on the first launch. It copies `Application Support/Baton` into
`Kovan` (caches skipped, the old folder left as it was), then re-encrypts
`secrets.json` from the "Baton Safe Storage" Keychain key to Kovan's own key.
`renderer/renamedKeys.ts` moves `baton.*` localStorage keys to `kovan.*`.
Keep them until nobody runs a Baton build any more.

The icon changed with the name (item 122): a K of seven hive cells, the stem
off-white, the working arm clay, the waiting arm grey. It and the menu bar
glyph are drawn by `resources/alternatives/build-k-cells.py`; change the
script, never the PNGs.

### GitHub's budget

The GraphQL limit is 5,000 points an hour **per account**, shared with every
agent's `gh` call, and the queue query runs every minute. GitHub prices a
query by what it *could* fetch, so a list inside a list multiplies: 50 pull
requests × 100 review threads made one poll cost 116 points instead of 4 and
used up the hour in 45 minutes (item 92). Before adding a field to
`PULL_FIELDS` or the queue query, measure it with `rateLimit { cost }`
(the poll already asks for it; the status bar's GitHub tooltip shows the
budget and each check's cost). Keep the poll in single digits; put anything
heavier in the per-pull-request detail query, which runs when you open one.
Anything that compares one poll with the last must skip a poll GitHub didn't
answer (`githubAnswered` in core): its empty lists aren't "nothing open".

Activity's comment count (`commentCount`) is conversation comments plus
reviews, so an approval raises it too. Don't treat a rise as a comment without
checking `lastReviewState`, the newest review's state from the same
`reviews(last: 1)` page (item 130). `reviewDecision` is no substitute: it stays
empty in a repository that doesn't require reviews, and it doesn't move on a
second approval. `diffActivity` reports an approving or change-requesting
review as that, and adds a "New comment" event only for whatever else the
count rose by.

### Terminals keep their xterm

`Terminal.tsx` keeps one xterm per session in a module-level map, so leaving
a view only parks its box, coming back moves the box into the new view, and
the xterm is disposed when the session closes (item 129). Don't go back to
building an xterm on mount and replaying the output into it. Claude Code draws
its input box and status line once and then rewrites only the cells that
change, so a replay of the capped 256 KB buffer has lost that first draw, and
the bottom of the screen comes back as stray digits. Replay is only for a new
window:

- It is drawn on the grid the pty has, which `Sessions` records
  (`SessionReplay.cols`/`rows`).
- The cap starts the buffer at a newline or an escape (`capBuffer`).
- When the replay was cut short, the renderer resizes the pty by one row and
  back, and the program redraws.

### macOS and Linux

Kovan is built for macOS first and also runs on Linux (x64 and arm64,
AppImage and .deb). Where they differ, the code asks `process.platform` in
main and `isMac` (`renderer/platform.ts`) in the window. Nothing else forks.

- **Shortcuts:** ⌘ on macOS is Ctrl on Linux. Use `isAppShortcut(event)`,
  never `event.metaKey`, and `keyLabel('K')` for any label. On Linux a
  terminal keeps its Ctrl keys (Ctrl+K cuts the line there), so app shortcuts
  don't fire while an `.xterm` has focus.
- **Window:** macOS gets our own title bar with inset traffic lights; Linux
  keeps the desktop's frame (`data-platform='linux'` drops the inset) and
  hides Electron's menu bar until Alt.
- **Private files go in private folders.** Linux's `/tmp` is shared between
  users. The terminal host's socket and pasted screenshots use
  `XDG_RUNTIME_DIR` there; anything else in temp uses `mkdtemp`.
- **Commands:** write the form both systems accept (`base64 --decode`,
  `ps -ww`), and don't hard-code `/usr/sbin`: lsof is on PATH on Linux.
- **macOS only:** dictation (a Swift helper and Apple's recogniser; its
  Settings pane is hidden on Linux) and the Dock menu. Open at login is a
  login item on macOS and `~/.config/autostart/kovan.desktop` on Linux, which
  starts Kovan with `--hidden`.
- **Checking Linux from a Mac:** `scripts/linux/run.sh` builds in Docker and
  runs the smoke tests on a virtual display; `pack` writes the packages.
  `KOVAN_SMOKE_LINUX` covers the differences above.

### Safety

- **Secrets go in and never come out.** Tokens and passwords are written through
  IPC and stored in the Keychain. The renderer only learns *whether* one is
  saved. An agent gets credentials as env vars that the prompt names, never
  the values.
- **Never build a shell string from data.** Use `spawn(executable, args)`. The
  only word ever interpolated into a shell line is a command name that has
  passed `isSafeCommandName`. Prompts go through a file (`"$(< file)"`) or
  stdin, never argv to a shell.
- **Resolve commands through `shellEnvironment`.** It probes an *interactive*
  login shell, because that's where `.zshrc` puts PATH entries such as
  `~/.local/bin`. A GUI-launched app's own PATH is not enough.
- Headless model runs start in an empty temp folder, with only the tools
  they need allowed (for example web search and fetch only).
- **The window is sandboxed, on a supported Electron.** It shows other
  people's text all day, so a Chromium bug there must stay there
  (`sandbox: true`, security review 2026-10). The preload is built as
  CommonJS (`index.cjs`) because a sandboxed preload can't be an ES module,
  and it may only use `contextBridge`, `ipcRenderer` and `webUtils`. Keep
  Electron within the three supported majors.
- **Links open through `openLink` (`main/external.ts`), never
  `shell.openExternal` directly.** Only `https`, `http` and `mailto` reach the
  OS; `file:` and custom schemes can launch things. A fixed URL of our own
  (System Settings panes) is the one exception.
- **Paths are file names, not patterns.** Git commands that take paths from
  a list run with `--literal-pathspecs`: a file called `:!x` would otherwise
  mean "everything except x".

### Preferences vs settings

- **localStorage**: per-window visual preferences (sizes, dock, sidebar width,
  last picker choice). Wrap every read and write in `try`. The app must work
  without it.
- **Settings store** (`window.kovan.setSetting`): anything main needs, or
  anything that must survive a profile reset (prices, environments, models).
- **Keychain**: secrets. Nothing else.

### Comments and copy

- Comments explain **why**, especially a rejected alternative or a bug that
  came from doing it the obvious way. Match the surrounding density.
- UI copy is plain and active, written from the user's side: "Check prices
  online", "Stop and close session". Error messages say what happened and what
  to do.

### Before calling it done

`npm run typecheck`, `npm test`, and for UI flows the smoke run
(`npm run smoke`). Visual changes are checked by looking at the running app,
not by reasoning about CSS. Record the item's status in `../improvements.md`.
