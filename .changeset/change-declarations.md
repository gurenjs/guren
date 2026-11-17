---
'@guren/cli': minor
---

`guren change:lane` and `guren change:evidence` now lower a fact an approved, open plan declares (RFC 0040 §3). An added source file that `plan:scaffold` writes for an element the plan adds is `low` when it is at that path and exports what the scaffold's own output exports; a policy's provider must be the one the scaffold writes, a policy or controller file must hold nothing but imports, types and the class, which extends the base the scaffold imports and has no member but the planned abilities or actions. An added table of a model the plan adds is `low` when its statement is the one the scaffold writes into that schema, columns, defaults, keys and indexes included. The report names the plan and the element (`declared by docs/plans/comments/plan.json#model.comment`), and `record.json` carries it as `declaredBy`. Nothing is declared in a change that writes a plan record, and a file or table a second open plan also claims stays where it was.

A declared table's own `sql` default and index callback are the scaffold's, so they no longer keep `db/schema.ts` at `medium`. An added migration is `low` when it does nothing but create the tables the plan adds, in the statements drizzle-kit writes (each `CREATE TABLE` with exactly the planned columns, each foreign key one the plan states with its delete rule, each index one it plans), its folder holds nothing but `migration.sql` and `snapshot.json`, and the snapshot is the previous migration's plus what the SQL creates.

A routes file, any other migration, an altered table, a removed file, a file a plan's `commands` write and an edit to a file an earlier task of the plan added stay `medium` for now.
