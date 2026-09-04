---
'@guren/cli': patch
---

Honor `--no-autofix` on `guren upgrade`.

The flag was declared as `noAutofix`, but citty's argument parser has a
dedicated `no-` branch that writes the key with the prefix *stripped*: passing
`--no-autofix` set `autofix: false` and never set `noAutofix` at all. The
command read `args.noAutofix`, which the args proxy resolved through `noAutofix`
then `no-autofix` — neither of which existed — so the flag read as `undefined`
and `guren upgrade` applied automatic fixes anyway, writing files the user had
asked it not to touch. Only the `--noAutofix` spelling worked.

The argument is now declared positively as `autofix` (defaulting to `true`), so
citty's negation lands on the key the command reads and usage advertises
`--no-autofix`. `--noAutofix` remains supported, because it is the spelling
`--help` advertised for as long as it was the only one that worked — treat it as
a documented alias, not as a shim to drop.
