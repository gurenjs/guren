---
'@guren/cli': patch
---

Compare an array entry against a caller's value on its unmasked source. Entries came back with string contents blanked, so a value holding a string literal — `mcpPlugin({ path: '/mcp' })` — never equalled an existing entry and the registration was appended a second time.
