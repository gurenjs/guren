---
'@guren/cli': minor
---

`guren doctor` gains a `supply-chain-cooldown` check for the release-age gate in `bunfig.toml`. It warns when the file sets no `minimumReleaseAge` (so an install takes package versions published moments ago), or when `minimumReleaseAgeExcludes` leaves out a `@guren` package the app declares or has installed (so installing a release of it younger than the gate fails). `minimumReleaseAge = 0` passes as the author's choice. `guren upgrade` applies the fix: it writes the block a scaffolded app ships when there is no `bunfig.toml` or no `[install]` table, and adds the missing names to a list written one entry per line. An `[install]` table it did not write, or a list in another shape, is left to the author, and doctor prints the line to add.
