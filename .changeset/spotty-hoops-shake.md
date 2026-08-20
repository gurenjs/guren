---
"@guren/cli": patch
---

`guren check` no longer demands a console registration for files under `app/Console/Commands/` that declare no command. A constants or helper module living next to the commands used to produce a warning that could never be resolved. The registration check now covers only files that could surface a command: a class (declaration or expression) with a superclass or a `signature`/`handle` member, a re-export with a source, or a default-exported identifier or call. Files that fail to parse stay in the check, since they cannot be shown to declare no command — and are no longer double-reported as "skipped" by the coverage summary. `guren context` lists commands through the same predicate, so the two commands agree about what a helper module is.
