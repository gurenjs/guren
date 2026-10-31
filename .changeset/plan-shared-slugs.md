---
'@guren/cli': minor
---

Two plans sharing a slug (`docs/plans/comments.plan.json` and `docs/plans/comments/plan.json`) are now detected once, by plan discovery, and every consumer reads that result. `plan:next`, `plan:verify`, `plan:scaffold` and `plan:close` refuse such a plan, since both would keep their step records in `.guren/plans/<slug>.state.json` and close into `docs/plans/<slug>.md`. The Dev Center serves no plan page for a shared slug (its review already refused one), `plan:revise` no longer applies a saved review under one, and `guren browser:map` refuses a plan whose slug any discovered plan shares, drafts included, rather than only another approved plan with views.
