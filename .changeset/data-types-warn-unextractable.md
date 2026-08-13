---
"@guren/cli": minor
---

`guren codegen` names the Resource classes it could not extract a `Data.*` type from, instead of dropping them in silence.

`generateDataTypes` recognises a documented subset of `toArray()` shapes. A Resource outside it type-checks, serves, and passes its own tests — the only symptom was a `Data` member that never appeared, under a run that reported success and, having matched the class pattern, then wrote `// No resources found`. Each miss now names the class, its file, and the shape to declare (`export interface PostResourceData { … }` plus `toArray(): PostResourceData`, what `make:resource` scaffolds). Two near misses get their own message, because the fix differs: an annotation naming a type declared in another file has to be moved rather than written, and an annotation in a shape codegen does not read (`Types.PostPayload`, `PostData<T>`) is quoted back rather than reported as no annotation at all. Warnings return from `generateDataTypes` the way `generateApiClientTypes` already returns its own, so `guren codegen` prints them and the MCP `guren_codegen` tool forwards them; the exit code is unchanged.

Four shapes are also read correctly now, all of which previously produced a wrong type or none:

- A type body was captured up to the first `\n}`, so a one-line `interface PostResourceData { id: number }` ran past its own closing brace and swallowed the class declaration below it, emitting a `data.gen.ts` that did not compile — costing the app every other resource's type as well.
- Locating that body required the declaration to carry `extends` or `=`, so a plain `interface PostPayload { … }` named by `toArray(): PostPayload` was dropped.
- A commented-out draft of the interface being looked for was matched ahead of the real declaration, describing a payload the app had stopped sending.
- A template literal type whose `${ … }` holds another template ended at the inner backtick, truncating the body mid-property.

Comments and string literals are now blanked (offsets preserved) before anything is matched, and bodies are read by counting brace depth. Output for shapes that already worked is byte-identical.
