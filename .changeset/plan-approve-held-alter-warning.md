---
'@guren/cli': patch
---

`guren plan:approve` warns, without refusing, on an `alter` whose readable planned properties all read `match` at approval (RFC 0030 §6): no such property can show its change, so the element completes only through a behaviour that reaches it or a waiver. The warning is judged on the approval entry's readings and listed under `heldAlters` in `--json`.
