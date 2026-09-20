---
'@guren/cli': patch
---

Add the acceptance-behaviour aggregation `plan:verify` will read (RFC 0030 §6): one status per behaviour from a `bun test --reporter=junit` report, with a strict reader that reports anything it cannot read as blocked.
