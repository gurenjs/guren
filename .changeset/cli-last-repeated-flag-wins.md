---
'@guren/cli': patch
---

Read a repeated CLI flag as its last value, on every command.

citty types a `boolean` arg as `boolean` and hands back an array when the flag
is passed twice, and every array is truthy. `Boolean(args.json)` reads as safe
and is not: `guren check --json=false --json=false` turned *off* into *on*, and
`--json --json=false` ignored the half typed last. Only the `=value` spellings
can express a false, so a bare `--json --json` never showed it. A helper fixed
four commands — `tool:call`, `tool:log`, `token:issue` and `context` — and left
about fifty reading raw, including `db:migrate`, `db:seed`, `check`, `audit`,
`doctor`, `config:show` and `schedule:list`.

The rule now lives in the CLI's own `defineCommand()` wrapper, which normalizes
the parsed args before `setup` and `run`, so no command can bypass it and the
per-command helpers are gone. A test gates every built-in command on having
been defined through it.

The same pass also gives a declared boolean the type citty gave only its
declared spelling. citty registers the *declared* name with its parser, so an
arg declared `dryRun` and spelled `--dry-run=false` arrived as the string
`"false"` — truthy. `guren db:migrate --dry-run=false`, `agent:sync
--dry-run=false` and `upgrade --check-only=false` now mean what they say,
repeated or not.

Commands contributed by plugins keep citty's own parsing: a repeated flag is
citty's only multi-value channel, and a plugin may mean its array.
