---
"@guren/cli": patch
---

Fix the CLI reads that silently misread source wrapped in a transparent TypeScript assertion.

Each tested a node's shape (`ObjectExpression`, `ArrayExpression`) without unwrapping `as const` / `satisfies` / `!` / `<T>x` first, so a wrapper made the declaration invisible. The failure is silent by construction: these scans report "cannot read this" and "nothing to flag" as the same empty result.

- `defineModel(users, { … } satisfies ModelOptions)` dropped every option at once, so `guren audit` reported a model with a `fillable` allowlist as having none, and a wrapped `base: AuthenticatableModel` lost its authentication classification.
- A string-array config read as unreadable when the array itself carried the wrapper — `static fillable = ['title'] as const`, the idiomatic spelling — with the same consequences plus a skipped denied-credential-column check.
- A wrapped drizzle column map made the whole table invisible to `parseSchemaTables`, and so to the schema checks, attachments table bindings, `make:feature`, and `guren context`. Wrapped column options read as opaque, so `timestamp('created_at', { withTimezone: false } as const)` skipped the Postgres `timestamptz` warning instead of earning it.
- `broadcast('c', 'e', { id: 1 } as const)` rendered as `unknown` in `.guren/channels.gen.ts`, typing every listener's argument as unusable rather than as the shape it carries. A wrapped *name* in the same call was worse still — the channel vanished from the generated types entirely — though that half is already fixed on main; a regression test now pins it.
- `export default { … } as const` was absent from the inert-default-export set, so a shared-constants module was treated as possibly holding a console command and drew a registration warning nothing could resolve.
- `mcpPlugin({ … } satisfies McpPluginOptions)` read as unreadable, and that scan's positive-evidence-only rule turned it into silence — an agent route requiring approval went unreported despite having nowhere to queue it.

A review sweep of the same files found more of the same class, now fixed too: a `defineModel` `base:` option, a `static passwordHashField = '…' as const`, the entries of a wrapped allowlist array, a relationship name, and the drizzle table and column names — a lost column name made the `timestamptz` warning cite the property instead of the SQL column and drop its `USING` hint.

Two widenings the unwrap could otherwise have caused are closed in the same pass. A `fillable: undefined as string[] | undefined` still reads as the absent option it is, rather than as mass-assignment protection the runtime does not apply. And a drizzle options object carrying a spread now reads as unreadable whether or not it is wrapped — `timestamp('c', { ...SHARED })` may well set `withTimezone`, so concluding "unset" warns about a column that was already right.

All now go through `objectLiteral()` / `literalString()` / `unwrapTypeAssertion()` from `ast-walk`, the one rule for reading through transparent wrapping. That rule also gains its first direct tests: five wrapper spellings were handled but only two were exercised anywhere, and `ParenthesizedExpression` was unreachable through the shared parser's plugin set at all.
