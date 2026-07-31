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

**Regenerating may surface new type errors in app code**, and they are pointing
at something real. A form field previously typed `Date` was already sending a
string over the wire; one typed `number` may receive `"3"` from an input. Widen
the local type, or narrow the schema if the route genuinely does not coerce.

Fixed alongside, all of which blocked the same scaffold from compiling:

- `z.array()` threw on Zod 4 and took `guren codegen` down with it, for any
  route whose body or output schema contained an array.
- `RouteBody<>` constrained its registry to a type with an index signature,
  which the generated `ApiRoutes` interface can never satisfy — the type could
  not be used with the one registry it exists for. The constraint is gone, and
  generated form pages now use `RouteBody<ApiRoutes, 'posts.store'>` in place of
  indexing `ApiRoutes` directly.
- A scaffolded `json` field validated with `z.record(z.unknown())`, which needs
  an explicit key type on Zod 4 and produces a value Inertia's `FormDataType`
  rejects. It is now `z.record(z.string(), z.any())`, edited through a textarea
  that tolerates mid-edit JSON, and rendered with `JSON.stringify` instead of
  being passed to React as an object. Apps that customized this validator keep
  their own version; only newly scaffolded features change.
- A scaffolded `date` field cast a `Date` column straight to `string` in its
  resource, and fed a full ISO timestamp to `<input type="date">`, which renders
  nothing for anything longer than `YYYY-MM-DD`.
- The scaffolded Edit page named its submit event `event`, shadowing the record
  prop for any entity whose variable name is also `event`.
