---
'@guren/openapi': patch
---

A route whose response is declared only by a `resource:` hint now produces a warning in `generateOpenApiDocument()` (and so in `guren openapi:generate` and `mountOpenApiDocs()`). The document still carries no response schema for that route, since a hint cannot be turned into JSON Schema; the warning names the route and suggests declaring `output`.
