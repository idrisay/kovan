# Improvements

What changed recently, and what is worth doing next. Newest first. When an
idea below is built, move it to **Done** with its item number and commit.

## Done

### Item 181: Edit the agent prompts in Settings › Prompts (2026-11-24)

Commit [`1b97ed7`](https://github.com/idrisay/kovan/commit/1b97ed7) on `linux`.

- Each agent prompt can be changed for every future run: Implement a ticket,
  Fix a Sentry error, Review a pull request, Review pull requests together,
  Unblock a pull request, Check it shipped. Until you save your own, a prompt
  stays Kovan's built-in text, and Reset brings that back.
- The run sheet's **Change it for every run** link opens the prompt it was
  built from. After a save, the open run sheet rebuilds its prompt.
- **Shared values** (base branch, pull request reviewers, checks, files not
  to edit) are now editable too. Before, they could only be changed in the
  settings file.
- Placeholder chips insert `${name}` and say what each becomes. A misspelled
  name is called out, and so is a prompt missing `${report}`. Preview shows
  the prompt as an agent would get it.
- When Kovan's built-in version changes after you customised a prompt, the
  editor says so, so you don't miss the change.
- "Review pull requests together" can now be overridden too. Before, main
  never read an override for it.
- Smoke item 181 runs the whole path.

### Item 180: Discuss can be made wider or narrower (2026-11-24)

Commit [`1b97ed7`](https://github.com/idrisay/kovan/commit/1b97ed7) on `linux`.

- Drag the Discuss panel's left edge in the Mixpanel tab. It stays at least
  260px wide, and the report always keeps at least 320px beside it.
- ←/→ on the focused edge move it 8px (⇧ for 32px). Double-click goes back
  to the default width. The width is remembered across launches.
- `Resizer` is now the one drag handle for any panel's width: the sidebar
  uses its defaults, and Discuss uses `edge="before"`. The sidebar behaves as
  before.
- Smoke item 180 drags both handles with real mouse input.

### Item 179: Discuss on Claude Code or any provider; no refetch on the tab (2026-11-24)

Commit [`55f9aad`](https://github.com/idrisay/kovan/commit/55f9aad) on `linux`.

- The model under the Discuss question box is a picker. It offers every
  opencode provider, plus "Claude Code, Codex, your commands": every Claude
  Code and Codex Kovan already found, your `claude-*` wrappers included,
  usable with no setup.
- Going back to the Mixpanel tab shows what was there at once and asks
  Mixpanel for nothing. The report list is kept until Reload. A report's
  numbers are asked for when you pick it, not when you come back.
- Smoke item 179 fakes Mixpanel and checks both.

## Ideas

### Discuss

- **Render answers as Markdown.** Answers are plain text with `pre-wrap`.
  Claude replies with numbered lists and paragraphs, which `Prose` (already
  used by the Summarize card) would lay out properly.
- **Make a failed answer actionable.** "Unexpected server error. Check server
  logs" (seen on the free opencode models) says nothing you can act on. Add
  **Ask again**, which re-sends the same question, and **Try another model**,
  which opens the picker.
- **Give Discuss its own timeout.** It uses the quick model's 90 seconds, so
  `nvidia/moonshotai/kimi-k3.1-pro` timed out on a plain question. Claude
  Code and Codex already get 10 minutes.
- **Cancel a running answer.** While a model answers, the only way out is to
  wait for the timeout.
- **Say which account answers.** With several `claude-*` wrappers listed, a
  short hint for each (the account or provider it signs into) would help
  you choose.

### Models and reviewers

- **The Review button could offer found agents too**, the way Discuss does,
  instead of requiring a reviewer to be added first. A review runs in a
  worktree of your clone, so the clone check would move to the moment of
  running.
- **"+ Add one of your own commands…" should open the Add form**, not just
  Settings › Agents, so you don't have to scroll to Reviewers and press
  "+ Add reviewer" yourself.

### Mixpanel tab

- **Show the list's age.** The report list is now kept until Reload. A quiet
  "list from 3d ago" next to the Reload button would make that visible.

### Prompts

- **Clean up the built-in prompts' double spaces.** They were ported from
  Swift with its line wrapping, so sentences carry double spaces
  ("first,  implement"). The agent doesn't mind, but they show in the editor
  and the preview.
- **Show what changed in the built-in prompt**, not just that it changed.
  Keeping the built-in text itself next to an override, not only its
  fingerprint, would allow a side-by-side comparison.
- **Per-repository shared values.** The base branch and pull request
  reviewers are global, but `develop` with four reviewers fits one
  repository, not every one. They could be keyed by repository, with the
  global values as the default.

### Install and tooling

- **The install script can swap the app under a running Kovan.** Run from a
  sandboxed shell, its `pgrep` didn't see the running app, so it replaced the
  bundle anyway and the old process kept running deleted code. It could
  check Kovan's single-instance lock (`SingletonLock` in the profile) and
  stop with a message when it can't tell.
- **The smoke `capturePage` sometimes returns the previous frame.** Item
  179's "answered" screenshot showed the picker still open, though the text
  checks passed. A shared `shot()` helper that waits for the next animation
  frame would fix every item at once.
- **Item 179 timed out once** (300s, no failure printed), then passed twice.
  Worth finding the step that hung.
