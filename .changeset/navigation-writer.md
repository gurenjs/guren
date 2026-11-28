---
'@guren/cli': minor
---

Add `guren nav:add` and `guren nav:remove`, which append an entry to `config/navigation.ts` or remove one. Each edit keeps the file's indentation and comma style and is read back before it is written. `--can <ability>:<Model>` imports the model from `@/app/Models/<Model>` and refuses when that file is missing, and removing the last entry that names a model removes its import. Both are generators a plan's `commands` may run.
