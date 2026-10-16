---
"@guren/cli": minor
---

The agent harness ships a `verify-in-browser` skill (RFC 0033 §5): read the feature map, start one instance with `browser:serve` (and report, never work around, its refusals), open a run, check it with `browser:doctor --evidence`, then drive each acceptance step or charter and record it with `browser:record`. Its results are evidence for the person, never a verdict a gate reads. `guren agent:sync` adds it to existing apps.
