# Baton

Read `DESIGN.md` before adding or changing a feature. It covers the visual
rules, the component and button weights, the behaviour rules (nothing
expensive runs on its own, AI output is a proposal, destructive actions are
conservative) and where code goes. Keep it current: when a change adds a
component or breaks a rule, update `DESIGN.md` in the same commit.

Checks: `npm run typecheck`, `npm test`, and `npm run smoke` for UI flows.
