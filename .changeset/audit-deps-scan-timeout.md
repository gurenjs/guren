---
"@guren/cli": patch
---

**`guren audit` stops spending a minute on a dependency scan that cannot finish** — `bun audit --json` spins at 100% CPU indefinitely on some dependency trees (reproduced on a scaffolded app whose `@guren/*` are `file:` links; the same app with those entries removed scans in under a second), and the scan's own cap was 60 s. Every such run therefore cost a minute before reporting the `Dependencies could not be scanned` warning it was always going to report. The cap is now 15 s, still an order of magnitude above the ~1 s a healthy scan takes. Nothing about the verdict changes: an unfinished scan is `unavailable`, never a pass.
