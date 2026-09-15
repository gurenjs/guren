---
'@guren/cli': patch
---

`--force` prints "Overwrote" for a file that already existed in `make:auth`, `make:module`, `make:feature`, `add auth`, `add admin`, `add resource` and the other `add` blueprints, as `guren deploy` does. They used to report every file as created. `WriterOptions` gains an optional `overwritten` array that collects the replaced paths, so a programmatic caller of `runBlueprint` or `scaffoldDeploy` can tell the two apart while both keep returning `string[]`.
