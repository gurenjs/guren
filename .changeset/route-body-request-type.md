---
"@guren/cli": patch
"@guren/inertia-client": patch
"create-guren-app": patch
---

Render route `body` types as the request shape, not the parsed one

`ApiRoutes[...]['body']` is consumed as the wire type — generated pages hand it
to `useForm`, and `createApiClient()` callers build request payloads from it —
but codegen emitted the schema's post-parse type. Those differ for every
coercing schema, and `z.coerce.date()` made the difference fatal: the body was
typed `Date` while a browser can only send an ISO string, so a `make:feature`
scaffold with a date field did not type-check at all.

`body` now renders the input side, where a coerced date is a `string` and a
coerced number is `number | string`. `response` still renders the parsed side,
and `guren context` keeps showing params/query as the controller receives them.
A `.pipe()` now resolves both sides independently; `.transform()` continues to
report its input type, since a transform's output is a function with no
recoverable type.

Field *presence* follows the same split, which it previously did not: a
`.default()`, `.prefault()` or `.catch()` field may be omitted from a request
but is always there once parsed, so it is optional in `body` and required in
`response`. `.readonly()`, `.brand()` and `.nonoptional()` are now understood
too — the first two previously made an optional field look required.

**Regenerating may surface new type errors in app code**, and they are pointing
at something real. A form field previously typed `Date` was already sending a
string over the wire; one typed `number` may receive `"3"` from an input. Widen
the local type, or narrow the schema if the route genuinely does not coerce.

Fixed alongside, all of which blocked the same scaffold from compiling:

- `z.array()` threw on Zod 4 and took `guren codegen` down with it, for any
  route whose body or output schema contained an array.
- Zod 3's `ZodPipeline` was not recognized at all, so `z.string().pipe(...)`
  rendered as `unknown` on apps still pinned to Zod 3.
- `RouteBody<>` constrained its registry to a type with an index signature,
  which the generated `ApiRoutes` interface can never satisfy — the type could
  not be used with the one registry it exists for. The constraint is gone, and
  generated form pages now use `RouteBody<ApiRoutes, 'posts.store'>` in place of
  indexing `ApiRoutes` directly.
- A scaffolded `json` field validated with `z.record(z.unknown())`, which needs
  an explicit key type on Zod 4 and produces a value Inertia's `FormDataType`
  rejects. It is now `z.record(z.string(), z.any())`, edited through a textarea
  that tolerates mid-edit JSON while flagging it, and rendered with
  `JSON.stringify` instead of being passed to React as an object. A json column
  is also no longer used as the Index page's heading, where React refused to
  render it. Scaffolding a json field now emits a `useState` flag on the form
  pages, so a parse failure is visible rather than silently submitting the last
  value that parsed. Apps that customized this validator keep their own version;
  only newly scaffolded features change.
- A scaffolded `date` field cast its column straight to `string` in the
  resource, and fed a full ISO timestamp to `<input type="date">`, which renders
  nothing for anything longer than `YYYY-MM-DD`. The resource now normalizes
  through `new Date(...)`, so it survives SQLite handing back a string where
  Postgres hands back a `Date`.
- The scaffolded Edit page named its submit event `event`, shadowing the record
  prop for any entity whose variable name is also `event`.
- `guren add resource` had no `date` case for SQLite — the default database —
  so a date field became a `text` column, and the `Date` the generated
  validator produces binds to that as `null`. **Every date was silently
  dropped on write.** SQLite now gets `integer(..., { mode: 'timestamp' })`,
  matching what Postgres and MySQL already did. The three dialect column
  builders are keyed by field type rather than falling through a `default:`
  arm, so a new field type cannot go missing from one dialect again.
- A field name that is not a valid identifier (`my-name:string`) generated a
  page that could not be parsed. `make:feature` now rejects it with a message
  instead.

Two known limits, both deliberate:

- Coerced types are rendered narrower than Zod would actually accept.
  `z.coerce.number()` also takes a `boolean` and `z.coerce.boolean()` takes
  anything at all, but a generated `body` is a type callers must *satisfy*, so
  it stays JSON-native and usable — a bare `boolean` is what drives a
  checkbox's `checked`. Widen the schema if a route really means "anything".
- `RouteBody<>` returns `Record<string, unknown>` for a registry entry with no
  `body`, including a malformed one. Constraining the registry is not an option:
  a generated `interface` can never satisfy an index signature, which is the
  bug being fixed here.
