---
'@guren/cli': patch
---

`guren audit` no longer reports a `deps:*` ignore entry as unused when the dependency scan did not finish (`--no-deps`, as `guren gate` runs it, or an unreachable registry), and a `deps:runtime:*`, `deps:runtime-scan` or `deps:runtime-unpinned:*` entry only once the Bun runtime check read every source.
