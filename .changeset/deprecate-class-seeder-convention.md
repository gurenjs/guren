---
"@guren/server": minor
"@guren/cli": minor
"@guren/core": patch
---

### Deprecated

- **Class-based seeder API (`BaseSeeder` / `Seeder`, `SeederRunner`, `createSeederRunner`, `resetCalledSeeders`, and the `SeederClass` / `SeederInterface` / `SeederRunnerOptions` types)** — Write seeders with `defineSeeder` instead. Deprecated in 2.9.0, will be removed in 3.0.0. Detected by `bunx guren upgrade --check-only` as `seeder-class-convention`.

A seeder class is not itself unsupported. `db:seed` loads seeders through `runSeeders()`, which accepts a `defineSeeder` handler, an exported `seed`/`run`/`Seeder`, or a default export — including an exported class whose prototype has a `run` method, which it constructs and calls as `run({ db })`. That last shape is deliberate: `packages/orm/tests/seeder.test.ts` covers it as "supports class-based seeders with run method".

What `BaseSeeder` gets wrong is the signature it imposes. Its `run()` is declared to take no parameters, so it hides the one argument a seeder needs. A subclass cannot simply correct that: declaring `run(ctx: SeederContext)` fails to compile against the base (`TS2416: Target signature provides too few arguments. Expected 1 or more, but got 0`). Widening it to an optional `run(ctx?: SeederContext)` does compile, but then the subclass must handle a missing context, and that case is real: `call()`, `callOnce()`, `callMany()` and `callParallel()` construct child seeders and invoke `run()` with no arguments at all, so a parent that received a context cannot pass it down. The result is a seeder that is counted as having run while its context handling is left to chance.

`SeederRunner` is the orchestration those classes were written for, and no Guren command reaches it. It runs a single seeder per call — a class passed in, a name registered with `register()`, or a name resolved to `<seedersPath>/<Name>.ts` defaulting to `DatabaseSeeder` — constructing it with `new` and invoking `.run()` with no context. `db:seed` does none of that; it runs every seeder in the folder.

Nothing is removed and no existing call changes its result. This adds `@deprecated` JSDoc naming the replacement, a once-per-process runtime warning from the `BaseSeeder` and `SeederRunner` constructors, and a `seeder-class-convention` entry in the deprecation registry so `bunx guren upgrade --check-only` reports affected files. No codemod ships with it: the migration moves a class body into a handler and has to resolve how each `call()`/`callOnce()` child receives `db`, which is not a mechanical rewrite.

These exports are re-exported from `@guren/core`, which makes them Stable under `contributing/api-stability.md`, so the deprecation policy's minimum of two minor versions applies before removal. Deprecated in 2.9.0, that permits removal from 2.11.0 onward: `removedIn` targets 3.0.0 on the assumption that 3.0.0 follows 2.11.0, which is also what keeps this removal in the same batch as `local-disk-per-object-visibility`. If 3.0.0 is cut earlier than that, this entry moves to the following major rather than being removed early.

The sibling `BaseFactory` / `Factory` / `defineFactory` exports live in the same directory and are deliberately untouched — `make:factory` scaffolds `class …Factory extends Factory<typeof Model>`, `Factory` being the `BaseFactory` alias.
