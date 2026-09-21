---
"@guren/cli": patch
---

Read plan references from one table, and judge `guren plan:render`'s checks per app root.

`plan/references.ts` now holds every place a plan element names another by id. The §2
reference checks, the task derivation and a revision's dangling-name rule all read it,
and a test holds the table to the plan schema's id-typed fields, so a reference added
to the schema cannot go unchecked in one of the three.

The checks against the application now read the app root a plan element names with
`module`: a same-named model, controller, action, validator, resource or policy in
another root no longer satisfies an `existing` nor collides with an `add`, and the
finding names the root. A table name still collides across every root, since each
module's schema is re-exported from the project's own `db/schema.ts` and lands in one
migration set. Pages keep being judged by their id, since a module's pages sit in the
project's own `resources/js/pages` under the module's name. An element's `module` must
be a non-empty string: `""` never named an app root, and a plan carrying one now fails
to parse. An `existing`, `alter`, `rename` or `drop` table the plan's own root does not
declare is left unjudged, with its columns, rather than judged against another root's.
