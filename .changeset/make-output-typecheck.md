---
'@guren/cli': patch
---

Compile every `make:*` generator's output in the test suite, and fix the three defects that gate found: `make:factory` now imports its model's record type and types the factory over it (`Factory<PostRecord>`, whose `definition()` returns the record's attributes) instead of naming a `Post` it never imported; `make:module`'s empty `db/schema.ts` is a module (`export {}`), so the root schema's `export *` no longer fails typecheck until the first table lands; `make:controller` passes the page title through the Inertia render options rather than as a prop the `make:view` page does not declare.
