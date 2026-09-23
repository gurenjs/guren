---
'@guren/cli': patch
---

`guren plan:verify` now fingerprints every file under the project's `routes/` for a planned entry route, not only the entry routes file. A route declared in `routes/comments.ts` and registered from `routes/web.ts` used to stay `verified` after `routes/comments.ts` changed; it now reads `drifted`, as a module's routes already did. A step verified before this release reads its routes `drifted` in `plan:status`, naming the files that run did not fingerprint, until `plan:verify --step` runs it again.
