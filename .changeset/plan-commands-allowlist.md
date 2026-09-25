---
'@guren/cli': patch
---

A plan's `commands` are now checked against an allowlist (RFC 0030 §8). A command passes only as `guren <subcommand>` or `bunx guren <subcommand>` naming a generator (`make:*` other than `make:migration`, `lang:publish`, `add <blueprint>` other than `add plugin`), with arguments free of shell syntax, absolute paths and `..` segments. Anything else is a failing `plan:command` check, which `plan:render` shows beside the command and `plan:approve` refuses. `plan:next` hands out no step of a plan carrying such a command, draft or approved, and `guren check --plan` warns about an approved plan that carries one. A plan that listed `bun run db:migrate` or another shell command under `commands` now fails approval until the command is removed; the `data` step's verify commands already run the migration.
