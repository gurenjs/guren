---
'@guren/cli': minor
---

Emit `inputSources` and `inputBodyNested` in `.guren/agents.gen.ts` (RFC 0016 §2).

The manifest carried the merged `inputSchema` but not the inverse of that merge, so a client holding it could only guess which contract each argument came from. Guessing by HTTP method is wrong in both directions: a POST route's `query` keys would land in the body, where `validateQuery` never looks, and a path parameter would be posted instead of substituted into a URL that cannot be built without it.

`inputSources` records the contract each merged property came from (`params` / `path` / `query` / `body`), and `inputBodyNested` marks a route whose non-object body was nested under a `body` key to give the tool an object root — a client that missed it would post `{ body: [...] }` to a route that validates the array itself. Both come straight off `deriveAgentTools()`, so the manifest and a live adapter still cannot disagree.

Rendered through the same `__proto__`-safe literal writer as the rest of the manifest: the keys are argument names, and an argument may legally be called `__proto__`.
