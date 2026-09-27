---
"@guren/cli": patch
---

Distinguish missing source directories from unreadable ones during file and module discovery. `collectFiles()` and the `discover*Files()` helpers now throw `FileDiscoveryError` for a directory that exists but will not open, and `guren check`, `guren audit` and `guren doctor` report the interrupted scan as one failure in text and JSON instead of treating the directory as empty. Whole-project walks still skip an unreadable top-level directory outside the source roots, such as a database bind mount.
