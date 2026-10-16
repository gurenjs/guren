---
"@guren/cli": minor
---

Add `guren browser:map` (RFC 0033): writes a browser verification feature map under `docs/browser/` from the application graph and approved plans. Generated sections sit between `guren:browser` markers and are replaced on each run; author text and frontmatter are kept, and markers that cannot be rewritten safely refuse the run with nothing written. `--check` reports a stale map without writing.
