---
"@guren/cli": patch
---

`make:seeder --help` no longer calls its argument a class name. The command
scaffolds a `defineSeeder` handler, which is what `db:seed` runs; the old
wording was the last user-reachable trace of a class-per-run seeder
convention the CLI never had.
