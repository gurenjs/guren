---
"@guren/server": minor
"@guren/cli": minor
"create-guren-app": patch
---

Routes can declare their response shape by naming the Resource that builds it, and the generated API client types `json()` from it.

`RouteContractOptions` gains a `resource` field: a Resource class, a one-element array (a collection), or a plain object of either (an envelope) — `resource: { data: [PostResource] }` mirrors `this.json({ data: PostResource.collection(posts) })`. Unlike `output`, nothing runs at request time; the hint is purely a type-level declaration, so the response shape lives in one place (the Resource's `toArray()` type) instead of being restated in Zod.

`definitions()` serializes the hint to class names (`RouteDefinition.resource`), and `guren codegen` resolves those against the Resource classes it already extracts into `.guren/data.gen.ts`, emitting the assembled shape (`{ data: Data.Post[] }`) as the route's `response` type — the same slot an `output` schema fills, and `output` still wins when both are declared. A hint naming a Resource class codegen cannot find warns and leaves that route's response untyped rather than claiming a shape the server does not send.

The blog starter's `posts.search` route now declares `resource: { data: [PostResource] }`, so its search page reads `json()` typed instead of asserting the shape at the call site.
