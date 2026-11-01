---
"@guren/cli": minor
---

`guren codegen` writes `.guren/forms.gen.ts` (RFC 0036 §2.1): one form contract per named route whose body schema is an object, carrying each key's type, requiredness, nullability, format and the constraints with an HTML counterpart, typed against the route's `ApiRoutes` body. It is written only for an app that depends on `@guren/inertia-client` and whose installed copy exports `./forms`; otherwise codegen removes a stale file and prints the `bun add @guren/inertia-client@latest` line. Two route names that camel-case to the same identifier fail codegen with both names. `guren check` compares the file with what codegen would write and suggests `guren codegen` on a difference, and the dev MCP server's codegen tool writes it too.
