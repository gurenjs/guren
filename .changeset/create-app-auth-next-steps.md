---
'create-guren-app': patch
---

`--auth` no longer lists `bunx guren add auth` under "Add features:" once the scaffolder has run it, and no longer repeats a users table step that told you to run `bun run db:make` first: `guren add auth` prints its own database steps and generates the migration itself. When the step fails after dependencies are installed, the warning no longer tells you to install them first.
