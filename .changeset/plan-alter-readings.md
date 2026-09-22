---
'@guren/cli': patch
---

`plan:status` no longer completes an `alter` on a planned property the application already held when the plan was approved. `plan:approve` records how each planned property of every `alter` read (on the approval entry, carried over to later approvals of the same baseline), and a match counts only against a reading that was a `differ` or `unknown`. An approval with no readings, such as one recorded before this release, leaves the `alter` `unjudged` until `guren plan:approve` is run again, which records the missing readings on the existing entry.
