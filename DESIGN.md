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
   you sure", like the armed session close.
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
- **Menu** (`.menu`): drop-down from a button. It closes on any outside click,
  and its rows are `role="menuitem"`. Use it for sort, filter, refresh and
  model pickers.
- **Sidebar** (`aside.queue` + `<Resizer />` + `main.pane`): every rail view has
  this shape. The width comes from `--queue-w` and the text size from
  `--sidebar-zoom`. Clicking the active rail icon hides it.
- **Rows** (`.row`, `.row.one-line`): list items. Actions that aren't always
  needed (rename, open, close) are **hover-revealed and take no space until
  hover** (`display: none` → `grid` on `:hover` / `:focus-within`), so names
  aren't truncated.
- **Settings sections**: an `h3`, a `.settings-note` explaining what it does in
  plain words, then controls. Steppers use `.font-size-control`.
- **Split quick button** (`.quick-split`): the label half runs the action, and
  the tag half shows the model plus FREE or `$in/$out`, and opens a provider and
  model picker. Any action that runs a model names that model on its button.
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

Form controls inside a `.menu` aren't styled by the sheet rules. Give them
the shared control look explicitly, and scope sheet-wide rules such as
`.run-controls input` so they don't reach checkboxes.

### Text size

There are three independent sizes, each remembered in localStorage: terminal
font (px), reading pane (`--reading-zoom`) and sidebar (`--sidebar-zoom`).
⌘+ and ⌘− change whichever region was last clicked (`zoomTarget.ts`). A new
region that wants its own size gets a `Scale` in `readingSize.tsx` and a
branch in `zoomTarget.ts`. It doesn't get a new keyboard shortcut.

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
   an agent or deleting a stored password needs either a confirmation or
   **arm-then-confirm** (first click turns the control amber and changes its
   label; a second click within 3s acts). An idle or finished thing can go on
   one click. Deleting data goes to the Trash when it's a file.
5. **State names what the user recognises.** "Waiting for you", "Checks again
   every minute", "Updated at 14:32". Ages under a minute get seconds, and
   anything relative has the absolute time in its tooltip.
6. **Remember the last choice** (runner, model, environment, dock position,
   sizes), per thing, not globally, when the thing differs.
7. **Everything in the main process keeps working with no window open.**
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
