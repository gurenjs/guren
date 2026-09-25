---
'@guren/cli': minor
---

Add `guren plan:revise`, which records a change to an implementation plan as a revision without calling a model. Pass the change as an edited copy of the plan (`--edited <copy> --message "<reason>"`, ops derived from the difference) or as ops (`--ops <file>`), and optionally the plan page's exported feedback (`--feedback`), whose approved elements then change only with `--reopens "<reason>"` and whose answered questions must be removed. The revision is written as `{ parent, ops, result }` to `revisions/<n>.json` beside a `docs/plans/<slug>/plan.json` (`<slug>.revisions/` beside any other plan), and the plan file is rewritten to the result. Drafts can be revised as well. A plan edited in place after approval is refused, with the steps to pass the edit as a copy instead. `plan:approve` and the per-step work measurement ignore the revisions directory the way they ignore approvals, and the plan page's footer now names `plan:revise`.
