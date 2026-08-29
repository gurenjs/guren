---
"@guren/server": minor
"@guren/core": minor
---

Derive agent tools from route contracts (RFC 0016 PR-1b).

- `deriveAgentTools(definitions)` turns the route definitions a router hands out into MCP-shaped tools: name, description, input/output JSON Schema (2020-12), annotation hints, authorization, approval and redaction. Only routes that declare `.agent()` *and* carry a name become tools; everything else about a tool derives from contracts the route already has, so a tool cannot advertise a schema the endpoint does not validate.
- Input merges `params` + `query` + `body` into one object schema, supplements path parameters the `params` schema omits as required strings, and nests a non-object `body` under a `body` key. Nothing throws: a key collision is reported as a warning and resolved deterministically in the body's favour, so the runtime derivation stays total (the static check fails the build instead).
- Annotation defaults follow the MCP spec: GET/QUERY are `readOnlyHint`, read-only tools are non-destructive, GET/QUERY/PUT/DELETE are idempotent. Explicit metadata always wins.
- Authorization is emitted only when the route's stamped capabilities make it unambiguous — one ability checked with `mode: 'all'`, or a resource check that resolves its ability from the built-in verb map. Anything else is omitted rather than guessed.
- The Zod → JSON Schema walker moved from `packages/core/src/internal/` to `packages/server/src/internal/`, with `@guren/core/internal/zod-compat` and `@guren/core/internal/zod-json-schema` kept as re-exports. `@guren/core` builds after `@guren/server`, so the walker had to move down to the package the derivation and the OpenAPI generator can both import. No consumer's import specifier changes.
