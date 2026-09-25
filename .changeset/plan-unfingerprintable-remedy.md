---
'@guren/cli': patch
---

`plan:status` and `plan:close` no longer suggest adding a behaviour for an element `plan:verify` cannot fingerprint. A behaviour added to the plan would still leave such an element held as unfingerprinted, so both now name only `plan:waive` for it.
