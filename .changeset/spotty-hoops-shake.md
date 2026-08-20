---
"@guren/cli": patch
---

`guren check` no longer demands a console registration for files under `app/Console/Commands/` that declare no command. A constants or helper module living next to the commands used to produce a warning that could never be resolved; the registration check now only covers files declaring a command class (a class with a superclass, or one carrying a `signature`/`handle` member). Files that fail to parse stay in the check, since they cannot be shown to declare no command.
