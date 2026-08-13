---
"@guren/cli": minor
---

`guren codegen` names the Resource classes it could not extract a `Data.*` type from, instead of dropping them in silence.

`generateDataTypes` recognises a documented subset of `toArray()` shapes. A Resource outside it type-checks, serves, and passes its own tests — the only symptom was a `Data` member that never appeared, under a run that reported success and, having matched the class pattern, then wrote `// No resources found`. Each miss now names the class, its file, and the shape to declare (`export interface PostResourceData { … }` plus `toArray(): PostResourceData`, what `make:resource` scaffolds). An annotation naming a type declared in another file gets its own message, because moving a declaration is a different fix from writing one. Warnings return from `generateDataTypes` the way `generateApiClientTypes` already returns its own, so `guren codegen` prints them and the MCP `guren_codegen` tool forwards them; the exit code is unchanged.

Two shapes are also read correctly now. A type body was captured up to the first `\n}`, so a one-line `interface PostResourceData { id: number }` ran past its own closing brace and swallowed the class declaration below it, emitting a `data.gen.ts` that did not compile — costing the app every other resource's type as well. Locating that body also required the declaration to carry `extends` or `=`, so a plain `interface PostPayload { … }` named by `toArray(): PostPayload` was dropped. Both now go through one reader that matches braces by depth and steps over comments and string literals; output for the conforming multi-line shape is byte-identical.
