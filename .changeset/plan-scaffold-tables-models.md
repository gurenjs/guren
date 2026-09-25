---
'@guren/cli': minor
---

`guren plan:scaffold <plan> --step <id>` writes the scaffold step of an approved plan (RFC 0030 §5), the step `plan:next` has marked. For each model the step adds, it appends the table to `db/schema.ts` in the schema's dialect, with every column option and foreign key the plan states, and writes the model class with the plan's `fillable` and relationships. It writes no validators, controllers, routes, resources, policies or pages yet, and runs no codegen or migration. Every refusal (a draft, another step kind, an unmarked step, a model in a module, an API-only app, a MySQL key on a text or json column, a null default, a target that already exists, a re-run included) comes before the first write, and a write that fails part way names the files already written. `plan:next` now names the command for a scaffold step and lists what it leaves to the `http` step, and `plan:status` and `plan:revise` list `plan:scaffold` among the commands an unapproved plan is refused by. A scaffold step's `generates` no longer lists pages. `guren add resource` writes its columns through the same builders, with unchanged output.

`plan:status` reads a column as part of the primary key when a composite `primaryKey({ columns })` lists it, so a pivot table's key columns can verify.
