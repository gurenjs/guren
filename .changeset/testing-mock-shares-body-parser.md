---
"@guren/server": minor
"@guren/testing": minor
---

Fix the controller mock parsing request bodies differently from the runtime.

The mock carried its own copy of the body parser, and the copies disagreed on three kinds of body. A mocked controller test therefore passed on behavior the runtime does not have:

- **An uppercase media type.** Hono lowercases the media type before deciding what a body is, so `Content-Type: APPLICATION/X-WWW-FORM-URLENCODED` is a form submission in production. The mock tested the raw header with `includes()`, read it as unsupported, and handed validation `{}`.
- **A repeated `field[]`.** Hono collects keys ending in `[]` into an array and the runtime then takes the first value, so `tag[]=a&tag[]=b` arrives as `{ 'tag[]': 'a' }`. The mock built its record with `Object.fromEntries(new URLSearchParams(...))`, which keeps the last, and read `'b'`. The same shape applied to multipart bracketed fields.
- **A content-type parameter.** Hono compares against the media type alone, so `text/plain; profile=application/x-www-form-urlencoded` is not a form. The mock's substring test could not tell a media type from a type that merely mentions one in a parameter, and parsed the body as a form.

The mock no longer decides any of this. It reads the runtime's own parser through the new `@guren/server/internal/request` subpath, wrapping its `Request` in a `HonoRequest` so that parser finds the three members it reads — `header()`, `json()`, `parseBody()` — from the same class a live request supplies. The media-type decision inside `parseBody()` is then Hono's own rather than a restatement of it, and the repeated-field collapse and the record view (`asRecord`, behind `parseRequestPayload`) are single copies shared with the runtime. Only the adapter is local, because the runtime is handed a Hono context and the mock holds a `Request`.

`packages/testing/tests/controller.test.ts` gains a parity table that runs json, urlencoded, multipart, unsupported and absent content types — plus uppercase and `;`-parameterized ones, repeated fields, and a body that must reach validation unnarrowed — through a real `Application.fetch()` controller and a mocked one, and requires the same answer from both. The suites either side of it exercised each implementation separately, which is why these divergences went unnoticed. It compares the value validation is handed; the record view's narrowing is pinned separately, as it was before.

The table guards the runtime as well as the mock: it is the runtime's answer that each row asserts first, so a change to `parseRequestBody` shows up here rather than in a mock that silently followed it. Note where it runs — `@guren/testing`'s suite is not part of `bun run test`, so `bun run test:testing` is the gate that speaks for this parity.

Two runtime behaviors the table now pins deserve naming, since both look like bugs and neither changed here: `Content-Type: APPLICATION/JSON` is **not** read as JSON, and `text/plain; profile=application/json` **is**. The runtime's JSON branch is a case-sensitive substring test on the raw header, so it is the one part of the decision Hono does not normalize.

`@guren/server` gains only that subpath — no behavior change, and nothing new on the package root. It is internal by the rules in `contributing/api-stability.md`: reachable only through a deep import under `internal/`, carrying no stability guarantee, and existing so the two packages cannot drift apart, exactly as `@guren/server/support/expiry` and `@guren/server/internal/route-path` do.

**Release step:** `@guren/testing`'s required `@guren/server` peer must be raised from `>=2.2.0` to the version this release publishes for `@guren/server` — the first one carrying the subpath. It cannot be raised in the pull request that adds it: `audit:plugin-compat` requires every `@guren/*` range to admit the version the workspace currently publishes, and that is still 2.13.0 until `changeset version` runs. So the edit belongs in the release pull request, beside the generated version bumps, and nothing catches it if it is skipped — the floor would then claim a compatibility this package does not have, and an install pinning `@guren/server` 2.13.0 while upgrading `@guren/testing` alone would fail to resolve the deep import.
