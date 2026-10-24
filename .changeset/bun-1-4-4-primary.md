---
'@guren/cli': patch
---

Guren is now tested on Bun 1.4.4 as its primary runtime; Bun 1.4.2 keeps a non-blocking CI lane. 1.4.4 fixes the `bun install` and `bunx` regressions that shipped in 1.4.3, and Guren's suite passes on it unchanged. `guren doctor` and `guren upgrade` still judge against Bun 1.4.0.
