---
"@guren/cli": patch
---

Point `db:make` at a `drizzle.config.json` instead of overriding it with defaults.

`makeMigration()` probed only `drizzle.config.{ts,mts,js,mjs}`, so an app whose
only drizzle config is the JSON one drizzle-kit names as its own default fell to
the no-config branch and was handed explicit `--schema db/schema.ts --out
db/migrations`. drizzle-kit then reported `dialect: undefined` — blaming the user
for a value they had declared, in a file nothing had read. `drizzle.config.json`
is now probed last, after the loadable formats, matching drizzle-kit's own
`.ts` > `.js` > `.json` preference.

This does not make JSON configs work: `bun x drizzle-kit` runs drizzle-kit
through its `#!/usr/bin/env node` shebang, and under Node its `import()` of the
config needs a `type: json` import attribute it does not pass, so such an app now
gets drizzle-kit's own error naming the config file it could not load. That is
the honest failure — the previous one described a different problem entirely and
pointed away from the config that caused it. Nothing regresses either: on the
pinned drizzle-kit, the flags branch those apps leave cannot succeed for anyone,
since a run passing `--schema`/`--out` without `--dialect` is rejected. Apps with
a `.ts`, `.mts`, `.js` or `.mjs` config, and any run passing `--schema`/`--out`
explicitly, are unaffected.
