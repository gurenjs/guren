---
"@guren/cli": minor
---

Add `guren browser:doctor --url <origin>` (RFC 0033 §4): a read-only check that a running app serves each mapped feature's landmark with the Inertia page the application graph says it renders, and records no server error on the mapped routes while it runs. It reports `pass`, `fail` or `inconclusive` (an incomplete map, an unavailable or inconclusive runtime-error window, or no landmark passing) and exits 0 only on `pass`.
