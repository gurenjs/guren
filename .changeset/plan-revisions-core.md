---
'@guren/cli': patch
---

Plan revisions, the model-free core (RFC 0030 §4). `plan/revision.ts` defines a revision as `{ parent, ops, result }`, the ops schema a revising producer is held to, and `applyRevision()`, which rejects a revision whose ops do not reproduce `result`, touch an approved element without `reopens`, or keep a question the feedback answered. `diffPlans()` computes the ops for a plan edited by hand. No command uses it yet.
