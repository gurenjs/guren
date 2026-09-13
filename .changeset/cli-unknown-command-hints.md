---
"@guren/cli": patch
---

Suggest what to run when `guren` does not know a command

`bunx guren attachments:prune` answered only `Unknown command attachments:prune`.
The name belongs to a console command the app registers, which runs through
`bun run console attachments:prune`. The error now adds:

- the closest builtin or plugin command names, when one is close
  (`db:migrate:status` suggests `db:status`)
- for a namespaced name at the root, that an app console command runs with
  `bun run console <name>`, that a plugin command needs an app with the plugin
  installed, and that `bunx guren console` is the REPL rather than the app
  command runner

The hint is computed from command names only; the CLI does not boot the app.
The same suggestion covers subcommands, so `bunx guren add attachmentz` suggests
`attachments`.
