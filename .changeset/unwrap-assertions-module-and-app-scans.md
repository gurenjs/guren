---
"@guren/cli": patch
---

Fix two `guren check` scans that silently misread config wrapped in a transparent TypeScript assertion.

Both read a call argument positionally and tested it for `ObjectExpression` without unwrapping first, so `satisfies` or `as const` around the object made the whole declaration invisible. That failure is silent by construction: these scans report "cannot read this" and "nothing to flag" as the same empty result.

- Route registrar wiring read `defineModule({ … })` bare, so `defineModule({ … } satisfies ModuleDefinition)` looked like a module with no descriptor at all. The scope then fell back to the conventional `modules/<name>/routes.ts`, and a module whose registrar lives anywhere else — `routes/index.ts`, say — had its whole routes directory reported as unmounted.
- The deploy-runtime scan read `createApp({ … })` the same way, so `createApp({ auth: {} } satisfies AppOptions)` dropped the session signal and the app passed the backed-session-store check instead of being warned. The file's generic identifier scan already walked through these wrappers; only this positional read did not.

Both now go through `objectLiteral()` from `ast-walk`, the one rule for reading an object literal through transparent wrapping.
