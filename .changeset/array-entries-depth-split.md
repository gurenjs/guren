---
"@guren/cli": patch
---

**Array-entry parsing now splits at depth 0**, so an entry holding a comma is one entry. Every patcher that answers "is this already registered" — `guren plugin`, `guren add`'s provider wiring, `make:module`, `make:command` — split an array literal's interior on *every* comma, with no awareness of nesting: `providers: [mcpPlugin({ path: '/mcp', prefix: '/x' })]` parsed as the two fragments `mcpPlugin({ path: '/mcp'` and `prefix: '/x' })`, and a nested array split the same way. A fragment matches neither the exact value a caller looks for nor, once the entry does not begin with the factory call, its prefix — so an existing registration read as absent and the command appended a duplicate.

Nesting is tracked with a stack over `()`, `[]` and `{}` on the same masked copy as before, so a name mentioned only in a comment still does not read as a registration. Regex literals are not masked; an unmatched closer stops the split there rather than cutting a fragment out of an entry, and the splits made before it stand.
