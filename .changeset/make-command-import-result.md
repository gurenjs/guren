---
'@guren/cli': patch
---

`make:command` now reads the result of the import patch it applies after registering the command: when the import cannot be added, it prints the reason and the import line to add by hand instead of reporting the command as registered over a file that names an identifier it never imports. A new `guren/no-discarded-patch-result` rule in `@guren/cli/oxlint` reports a call to a `PatchResult`-returning helper whose result is discarded.
