---
'@guren/cli': minor
---

The agent harness ships a `fix` skill (RFC 0040 §6): a defect is reproduced as a failing `TestApp` test committed alone, then fixed in a second commit, then reported with `guren change:evidence`; an escaped defect ends with a draft lesson from `make:lesson --from <commit>`. `plan-write` and the `guren add review` issue templates state which changes get a plan: one that adds or alters a model, a route, a policy or a page. Run `bunx guren agent:sync` to install it.
