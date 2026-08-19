---
"@guren/cli": patch
---

Accept `guren context --entity <Model>`, which citty silently dropped

`context` declared its `entity` argument `type: 'positional'`. When a value is passed to a positional as a flag, citty 0.1.6 discards it entirely — it reaches neither `args.entity` nor the unconsumed positionals in `args._`, and no unknown-flag error is raised — so `guren context --entity User` ran as if no entity had been named. This command's no-entity branch is the whole-project map, so it printed that and exited 0: the wrong output, with nothing signalling the argument had been ignored.

The flag spelling is one the docs teach rather than an invented one. `--entity <Model>` is a real string flag on both `make:adr` and `docs:graph`, documented in the CLI guides in English and Japanese and in the agent harness template, so `context --entity User` is a natural thing to write after reading them.

`entity` is now `type: 'string'` and falls back to `args._[0]`, which accepts `guren context User`, `--entity User`, and `--entity=User` alike; a string arg still leaves an unconsumed positional in `_`, so the documented positional form is unchanged, including alongside `--module`. `guren context --help` now lists `--entity=<User>` under OPTIONS rather than as an `[ENTITY]` argument, and its description names the positional spelling.

`queue:retry` has the same optional-positional declaration and is deliberately left as it is: its `id`/`--all` guard reports the missing id and exits 1 when the value is dropped, so the wrong spelling is already refused loudly rather than acting on the wrong input.
