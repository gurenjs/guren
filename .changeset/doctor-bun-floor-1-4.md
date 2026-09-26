---
'@guren/cli': patch
---

`guren doctor` and `guren upgrade` now warn on a Bun older than 1.4.0. CI no longer runs a Bun 1.3.x lane, so 1.3.x is best-effort: it may keep working, but nothing tests it.
