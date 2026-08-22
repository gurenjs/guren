---
"@guren/server": patch
"@guren/core": patch
"@guren/orm": patch
---

Declare `sideEffects` so bundlers can tree-shake the framework. Without it a bundler must assume every module in the barrel may have a load-bearing top-level effect, so `export * from '@guren/server'` pulled the whole server package into a deployed function — mail (and nodemailer behind it), cache, queue, redis and the rest — for an app that imported none of them.

This is what a serverless cold start pays for on every invocation. Measured against a fixture that resolves `@guren/*` from `dist` the way an installed app does, bundling a two-line entry that only uses `createApp` with the same stub set and options `@guren/plugin-vercel` uses: 1,137,335 to 672,676 bytes (-40.9%, 224 modules to 133), and its cold start from a 55.2ms to a 37.1ms median (-32.7%, n=30 per arm, interleaved). Of the modules that drop, 89 are ioredis, nodemailer and their transitive dependencies.

`@guren/orm` and `@guren/core` use the array form rather than `false`, because `instance-guard` (the duplicate-copy detector) and `bin` exist only for their side effects. Two things are worth knowing before anyone simplifies this:

- The ORM's dist entry names `./dist/index.js`, not `./dist/instance-guard.js` — tsup inlines the guard into the barrel rather than emitting it as its own file, so the per-file path would have matched nothing. Making it a separate tsup entry does not help: the guard then lands in a content-hashed chunk that no `sideEffects` entry can name stably.
- Under Bun, `sideEffects: false` on the ORM also keeps the guard whenever an app uses the ORM, because Bun will not treat the guard's top-level global write as pure — so Bun alone cannot distinguish the two forms. The array is what makes the guarantee portable to rollup and webpack, which drop a bare-imported module from a `sideEffects: false` package by design. It costs 955 bytes for an app that never touches the ORM, since `@guren/core`'s barrel re-exports ORM names and so keeps the guard reachable.

`@guren/server` is `false`: it has no module-scope side effects at all — no bare imports, no global mutation, no prototype patching outside function bodies.

Both declarations are pinned by source-level tests, because nothing at runtime can check them: `bun test` never bundles, so a regression here would stay green everywhere and surface only in a bundled serverless build. One fails if a bare import appears under `packages/server/src`; the other fails if an entry in the ORM's array stops naming a file that carries the guard.

No API changes, and nothing changes for unbundled apps — `sideEffects` is only read by bundlers.
