---
'@guren/cli': minor
---

`guren plan:approve <plan>` approves an implementation plan (RFC 0030 §4). It refuses while a reference check fails or a question is still open. A draft has its `baseline` stamped once and written into the plan file: `rev` is the application's `HEAD` (outside a git repository, or before the first commit, the command refuses) and `contextHash` holds one hash per element the reference checks judge by name. A plan that already carries a baseline, as a revision carries its parent's, is never restamped. The approval, `{ hash, approvedAt, approvedBy }`, is recorded beside the plan in `approvals.json` next to a `docs/plans/<slug>/plan.json` and in `<slug>.approvals.json` next to any other plan; approving the same hash again writes nothing. `plan:status` now reports, for a plan with a baseline, whether each element is fresh against its stamp, stale, unstamped or unjudged, and names the elements that depend on a stale one.
