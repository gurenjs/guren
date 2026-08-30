---
"@guren/server": minor
"@guren/core": minor
---

Derive agent tools from route contracts (RFC 0016 PR-1b).

- `deriveAgentTools(definitions)` turns the route definitions a router hands out into MCP-shaped tools: name, description, input/output JSON Schema (2020-12), annotation hints, authorization, approval and redaction. Only routes that declare `.agent()` *and* carry a name become tools; everything else about a tool derives from contracts the route already has, so a tool cannot advertise a schema the endpoint does not validate.
- Input merges `params` + `query` + `body` into one object schema, supplements path parameters the `params` schema omits as required strings, and nests a non-object `body` under a `body` key. Path parameters are required whatever describes them — a schema declaring one optional gives its *type*, not permission to omit it from a URL. Nothing throws: a key collision is reported as a warning and resolved deterministically in the body's favour, so the runtime derivation stays total (the static check fails the build instead).
- Annotation defaults follow the MCP spec: GET/QUERY are `readOnlyHint`, read-only tools are non-destructive, GET/QUERY/PUT/DELETE are idempotent. Explicit metadata always wins.
- Authorization is emitted only when the route's stamped capabilities make it unambiguous — one ability checked with `mode: 'all'`, or a resource check that resolves its ability from the built-in verb map. Anything else is omitted rather than guessed.
- A route's `resource` hint is carried only when the route declares no `output` schema — declared, not merely renderable, so an `output` the walker cannot express still outranks the hint rather than letting an unvalidated claim describe the response.
- The Hono path lexer is now shared too (`@guren/server/internal/route-path`, re-exported by `@guren/core/internal/route-path`). `@guren/openapi` had its own copy that dropped a trailing `*` while lexing, so `/files/:name*` named the parameter `name` there and `name*` — what Hono registers — everywhere else. Its documents are byte-identical: OpenAPI path templates are RFC 6570 URI templates where `{name*}` means "explode", so the asterisk is now stripped where the document renders instead of where the path is read.
- The Zod → JSON Schema walker moved from `packages/core/src/internal/` to `packages/server/src/internal/`, with `@guren/core/internal/zod-compat` and `@guren/core/internal/zod-json-schema` kept as re-exports. `@guren/core` builds after `@guren/server`, so the walker had to move down to the package the derivation and the OpenAPI generator can both import. No consumer's import specifier changes.
