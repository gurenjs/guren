---
"@guren/cli": minor
---

Add `guren browser:record` (RFC 0033 §7), the one writer of a browser verification run under `.guren/browser/<run>/`: `--begin` records the origin, graph snapshot and commit; `<run> --step <id> --open` takes the runtime-error head; `--close --input <file|->` records the agent's account beside what the CLI measured (screenshot digests, the error window) and lowers a pass on a server error or an unreadable window. `browser:doctor --evidence <run>` writes its report into the run.
