---
'@guren/cli': patch
---

`make:command` now registers the command and adds its import in one write, through a new `addEntryWithImport()` in the patch helpers that `addArrayOptionRegistration()` shares: an entry that cannot be placed leaves the file untouched, and an entry already listed gets a missing import restored. The `guren/no-discarded-patch-result` rule also covers the helpers returning an `EntryWiring`.
