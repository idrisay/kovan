# Baton design patterns

How Baton looks, behaves and is built. Follow this when adding a feature or
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
to it, or it must be a token. Fonts are bundled (`@fontsource`); the renderer
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
| `.quick` (dashed blue) | Not an agent: a quick model turning text Baton already has into shorter text | Summarize, nv-review |
| `.ghost` | Everything else: secondary actions, Settings actions | Terminal, Open on GitHub, Add a row |
| `.link` | Inline, low-weight action inside text or a table row | Remove, Reset, Cancel, Save as default |
| `.icon-button` | Icon-only, borderless. Needs `aria-label` **and** `title` | Row actions, rename |
| `.icon-button.boxed` | Icon-only with a box, for a header's own control | Close ✕ on sheets and terminals |

Put at most one `.primary` in a row. Separate groups of different weights with
the existing vertical rule, not with space alone.

### Surfaces and containers

- **Sheet** (`.sheet-backdrop` > `.sheet`): modal for settings, run setup and the
  run viewer. The header is `.sheet-head` with an `h2` and a **boxed ✕ close**,
  never a "Done" button. Clicking the backdrop closes it too.
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
  title, state first; a click opens the pull request in Baton, not on GitHub.
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
  `baton-dictate` Swift helper (Chromium's speech API doesn't work in
  Electron); it exits on stdin EOF, so the mic can't outlive Baton.
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

### Keyboard

⌘F focuses the sidebar filter (except inside the code editor). ⌘+ and ⌘−
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
7. **Baton is a normal Dock app** with a menu bar glyph as well. Opening
   it, clicking its Dock icon or Cmd+Tabbing to it shows the window; closing
   the window keeps it running. Quitting asks first while sessions run.
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
renderer call. Name it `baton:<noun>-<verb>`.

### The log

Everything `host.log` writes, anything that throws in main, the window's
process going away, and every error in the window (render errors with their
component stack, uncaught errors, unhandled rejections) goes to
`~/Library/Logs/Baton/baton.log` (`main/logFile.ts`), rolled to `baton.1.log`
at 1 MB. A smoke run with `BATON_USER_DATA` logs under that folder instead.
When something breaks, read the log before guessing. Take the headline flag
with `primaryFlag(pull)`, never `pullFlags(pull)[0]!`: a pull request can
have no flags at all.

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

### Preferences vs settings

- **localStorage**: per-window visual preferences (sizes, dock, sidebar width,
  last picker choice). Wrap every read and write in `try`. The app must work
  without it.
- **Settings store** (`window.baton.setSetting`): anything main needs, or
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
