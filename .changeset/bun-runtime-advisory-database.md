---
'@guren/cli': minor
---

The Bun runtime check in `guren audit` reads GitHub's advisory database for the npm package `bun` beside `oven-sh/bun`'s repository advisories, joined by GHSA. The database has held an advisory the repository does not (GHSA-v9mx-4pqq-h232). When one source cannot be read, the check is `partial`, `deps:runtime-scan` warns, and `--deps-baseline` fails; `runtimeCheck.sources` names what was read. `guren doctor`'s `supply-chain-cooldown` also warns when an exact Bun version the app names is older than 1.3.0, the first release that reads `minimumReleaseAge`: older ones install past the gate without a word.
