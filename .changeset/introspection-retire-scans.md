---
'@guren/cli': minor
---

`guren gate` reads the introspected app, and the source readings that only stood in for it are gone (RFC 0026 Part 3). The gate's `check` and `audit` stages share one introspection per run, after its codegen stage and capped at 10 seconds; one that fails adds an `Introspection (advisory)` line to the stage that asked and never fails the gate. `guren plan:verify` introspects its `check` too. The edit hook and the dev MCP server's `guren_check` still do not, so there the verdicts below are `-unverified`.

Without a manifest (no introspection, a failed one, or a provider that threw in `register()`), two keys that used to gate become advisory: `sessions-binding` (a warn that failed `check --ci`) and `attachments-delivery:*` (a fail) are reported as `sessions-binding-unverified` and `attachments-delivery-unverified:*`, which no gate counts. `guren gate` and `guren plan:verify` print every such `-unverified` result as an advisory line on their check step, naming why the app could not vouch for it, so a CI run with no manifest still shows them. `guren check`, `guren audit`, `guren doctor`, `plan:verify`, the gate and the deploy builds now share one introspection cap of 10 seconds (it was 30 for the three commands), so `check --ci` and the gate cannot disagree about an app that registers in between; `guren introspect --timeout` diagnoses a slower one.

Verdicts that can change, by check key:

- `deploy-password-hashing` becomes `deploy-password-hashing-unverified` (advisory warn, `evidence: 'none'`) when there is no introspected app (`--no-introspect`, a failed introspection, an in-process caller that does not introspect) or it cannot vouch for `auth` (a provider threw in `register()`). It was judged from `new ScryptHasher()`, `Hash({ algorithm })` and `auth.hasher` in source, which is no longer read. An app that registers no user provider while its source calls `auth.attempt()` or `auth.useModel()`, or constructs a `ScryptHasher`, is `-unverified` too.
- `deploy-runtime-stores` becomes `deploy-runtime-stores-unverified` for the same causes, and whenever the session store cannot be vouched for, not only the cache. The `SessionConfig` driver reading is gone; the message still lists what the source shows (OAuth state stores, explicit `Memory*` constructions). A `createApp({ auth: { sessionOptions: { store } } })` factory is judged by the database or Redis store the source constructs.
- `sessions-binding` becomes `sessions-binding-unverified` (advisory) without an introspected app. The scan for a provider class named in `src/app.ts` is gone.
- `attachments-delivery:*` and `attachments-serve-redirect:*` become `attachments-delivery-unverified:*` and `attachments-serve-redirect-unverified:*` (advisory) without an introspected app; they no longer load the routes file. For a `configureAttachments()` in a provider's `boot()` the mount and each disk's driver come from the introspected app's routes and storage manager.
- `sessions-config:*` and `attachments-config:*` keep their source verdict without an introspected app, since a missing schema export is a link error that fails the introspection.

### Deprecated

- **`analyzeDeployRuntime()` / `judgeDeployRuntime()`** (`deploy-runtime-analysis`): call `checkDeployRuntime(cwd)`, which returns the verdicts. Both keep working, warn once per process, and now introspect the app by default; the `DeployRuntimeAnalysis` fields for the removed signals (`bunOnlyHasherSignals`, `nodeHasherSignals`, `unreadableHasherSignals`, `unreadableConfigSignals`, `memorySessionDefaultSignals`, `unknownSessionDriverSignals`) are always empty. Deprecated in `@guren/cli` 2.28.0, will be removed in 3.0.0. Detected by `bunx guren upgrade --check-only` as `deploy-runtime-analysis`.
