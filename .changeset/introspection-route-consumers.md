---
'@guren/cli': minor
---

`guren check`'s route rules, `guren doctor`'s `prototype-routes` and `guren context` read the introspected app's routes (RFC 0026 Part 2d), so a route a provider or plugin registers is judged and listed, and a module under `modules/` that `createApp()` never mounts is not. `guren check` introspects for them only once the routes file registers a route with a params schema or a binding, a route that declares `.agent()`, or a `prototype` route (or the app has a prototype fixture), never with `--routes`; `--no-introspect`, a failed introspection and a provider that threw in `register()` read the routes file as before. `runCheck()` introspects only with `introspect: true`, so `guren gate` and the edit hook are unchanged.

Verdicts that can change on the manifest path, by finding key:

- `route-contract-params:*`, `route-contract-params-optional:*`, `route-contract-bind:*`: reported for a route a provider or plugin registers too. A params schema's keys come from the manifest's JSON Schema (`properties`, severity from `required`); where that rendering is short of the schema (a nullable object, a transform, a `z.any()` or `z.undefined()` key), the routes file's Zod for the same route decides, and a route with none is reported unreadable. `route-contracts` counts the app's routes.
- `agent-route-*`: judged for every route the app registers with `.agent()`. The rules now introspect whenever the routes file has an agent route, not only when one names a controller.
- `prototype-fixture-orphan:*`: an entry naming a route the app registers outside the routes file is no longer an orphan. `prototype-fixture-unverified` is not reported when the routes file fails to load but the app registers.
- `prototype-routes` (doctor): counts routes a provider registers with the `prototype` handler.
- Every result of these rules carries `evidence` in `--json`: `manifest`, or `static` for a verdict read from a controller body, the app entry's `createApp()` or the fixture's parse, and for every result judged from the routes file (with the reason in the message when introspection was asked for but not used). `prototype-routes` carries `evidence` and `evidenceReason` in `doctor --json`.

`guren context` takes `--no-introspect`; `--routes` also reads the routes file. Schema types are still rendered from the routes file's Zod, so a route only the app registers is listed without them, and `controller` keeps its `{ name, action }` shape. `guren context <Entity>` passes the flag on, and introspects only when a route reaches a controller class two files declare.

`guren codegen` and `guren routes:types` take `--introspect`, off by default: the app decides which routes exist and in which order, and each is rendered from the routes file's Zod, so the output is byte for byte the default's when every route comes from the routes file and its modules. A route only the app registers is added without schema types, with a warning, and its agent tool comes from the manifest. A failed introspection writes from the routes file and says why. `spec:generate` and `check --spec` always read the routes file, and so does the agent-manifest rule `check` and `doctor` share, since it follows what codegen writes by default.
