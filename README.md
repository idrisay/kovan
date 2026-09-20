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

## Known gaps

- **Idle memory is ~244 MB**, against the Swift app's few MB. Measured, not
  estimated; see MIGRATION.md §9 for the breakdown and what was tried.
- `noUncheckedIndexedAccess` is off, matching the extension's original compiler
  contract. Turning it on means auditing ~17 regex `match[1]` sites.
- Queue scoping is account-wide only. Folder and workspace modes need the clone
  index from `@baton/git`, which lands with Phase 5.

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
