---
'@guren/cli': patch
---

Plan revisions, the model-free core (RFC 0030 §4). `plan/revision.ts` defines a revision as `{ parent, ops, result }`, the ops schema a revising producer is held to, and `applyRevision()`, which rejects a revision whose ops do not reproduce `result`, leave the plan as it was, touch an approved element without `reopens`, or keep a question the feedback answered. A revision that reproduces neither its `result` nor a plan different from its parent is refused under two kinds, so a consumer can tell the operation at fault from a revision that changes nothing. `diffPlans()` computes the ops for a plan edited by hand. No command uses it yet.
