---
"@guren/cli": minor
---

A plan's acceptance behaviour can carry `"alreadyHolds": true` for a behaviour that holds before the plan's work, such as a guest already sent to sign in on a route that exists. The `tests` step's `tests:fail` no longer asks such a behaviour to fail first, and the step that runs the tests still needs it to pass. `plan:render` and `plan:approve` now warn before approval about a behaviour whose test may pass before its implementation, on a route that exists already or that an earlier task mounts, which `plan:scaffold` listed only after approval, and about a mark on a behaviour whose route nothing answers yet. The plan page shows the mark, `plan:next` lists it, and the producer prompt asks for an `unauthenticated` behaviour only on a route the plan adds or alters. A plan without the field keeps its hash, so approved plans stay approved. Run `bunx guren agent:sync` to pick up the updated `plan-implement` skill.
