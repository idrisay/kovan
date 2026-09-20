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
| 3b | Re-point the VS Code extension at `packages/*` | **not started** |
| 4 | Terminal + agent runner (`node-pty`, run archive) | not started |
| 5 | Workbench: explorer, Monaco editor, diff | not started |
| 6 | Workspaces, Activity, Sessions, reviewers | not started |
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
packages/core        pure domain logic. Shared with the VS Code extension.
packages/providers   GitHub and Jira clients, HTTP, credentials.
apps/desktop
  src/main           tray, poller, notifications, IPC — works with no window
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
