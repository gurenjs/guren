---
'@guren/cli': minor
---

`guren change:lane` and `guren change:evidence` now lower a fact an approved, open plan declares (RFC 0040 §3). An added source file that `plan:scaffold` writes for an element the plan adds is `low` when it is at that path and exports what the scaffold's own output exports; a policy's provider must be the one the scaffold writes, a policy must be an exported class holding exactly the planned abilities, and a controller an exported class with no member but the planned actions. An added table of a model the plan adds is `low` when its statement is the one the scaffold writes into that schema, columns, defaults, keys and indexes included. The report names the plan and the element (`declared by docs/plans/comments/plan.json#model.comment`), and `record.json` carries it as `declaredBy`. Nothing is declared in a change that writes a plan record, and a file or table a second open plan also claims stays where it was.

A routes file, a migration, an altered table, a removed file, a file a plan's `commands` write and an edit to a file an earlier task of the plan added stay `medium` for now, and so does `db/schema.ts` when a table's default or index config is written as a function (the scaffold's own output does this).
