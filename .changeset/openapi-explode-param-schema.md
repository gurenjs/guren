---
"@guren/openapi": patch
---

Fix: a path parameter carrying an explode modifier (`/files/:slug*`) now documents the schema its route declares, instead of falling back to `{ "type": "string" }`.

The parameter's schema was looked up by the name the document renders (`slug`), while a route's `params` schema is keyed by the name Hono registers and hands the handler (`slug*`) — the only name an app can write. The two never matched, so a declared `z.object({ 'slug*': z.coerce.number().int().positive() })` was discarded and the document advertised a bare string where the endpoint requires a positive integer. The lookup now uses the raw parameter name, while the rendered name keeps the modifier stripped, as OpenAPI path templating requires (RFC 6570 reads `{slug*}` as "explode").

The same lookup now reads own properties only, so a parameter named `__proto__` can no longer resolve to `Object.prototype` as though it were a declared schema.
