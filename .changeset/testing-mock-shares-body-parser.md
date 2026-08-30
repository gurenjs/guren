---
"@guren/server": minor
"@guren/testing": patch
---

Stop `@guren/testing`'s controller mock keeping its own copy of the request-body parser.

The mock reimplemented the runtime's rules for reading a body, and the copy drifted from the original repeatedly. Every one of these was a separate fix to the copy, each landing after a mocked controller test had already passed on behavior the runtime does not have: an uppercase media type, a `;`-parameterized one, a repeated `field[]`, a `__proto__` field, and a body no parser can decode.

Those fixes stand; this removes what made them necessary. The mock now reads the runtime's parser through the new `@guren/server/internal/request` subpath, wrapping its `Request` in a `HonoRequest` so the parser finds the three members it reads — `header()`, `json()`, `parseBody()` — from the same class a live request supplies. The media-type decision inside `parseBody()` is then Hono's own rather than a restatement of it, and the repeated-field collapse, the `{}` fallback and the record view (`asRecord`, behind `parseRequestPayload`) are single copies shared with the runtime. Only the adapter stays local, because the runtime is handed a Hono context and the mock holds a `Request`.

No behavior changes for either package. The copies had already been brought into agreement, so this is the structural half: they are now the same code rather than two implementations that match. One restatement remains and is marked as such — `Controller.file()` / `files()` gate the multipart read on the media type *before* parsing, and that pre-parse gate has no shared home to read from.

`packages/testing/tests/controller.test.ts` gains a parity table running json, urlencoded, multipart, unsupported and absent content types — plus uppercase and `;`-parameterized ones, repeated fields, and a body that must reach validation unnarrowed — through a real `Application.fetch()` controller and a mocked one, requiring the same answer from both. It complements the per-divergence tests already there by covering the space rather than the known cases, and it guards the runtime as well as the mock: each row asserts the runtime's answer first, so a change to `parseRequestBody` surfaces here instead of in a mock that silently followed it. Note where it runs — `@guren/testing`'s suite is not part of `bun run test`, so `bun run test:testing` is the gate that speaks for this parity.

Two runtime behaviors the table pins deserve naming, since both look like bugs and neither changed here: `Content-Type: APPLICATION/JSON` is **not** read as JSON, and `text/plain; profile=application/json` **is**. The runtime's JSON branch is a case-sensitive substring test on the raw header, the one part of the decision Hono does not normalize.

`@guren/server` gains only that subpath — no behavior change, and nothing new on the package root. It is internal by the rules in `contributing/api-stability.md`: reachable only through a deep import under `internal/`, carrying no stability guarantee, and existing so the two packages cannot drift apart, exactly as `@guren/server/support/expiry` and `@guren/server/internal/route-path` do.

**Release step:** `@guren/testing`'s required `@guren/server` peer must be raised from `>=2.2.0` to the version this release publishes for `@guren/server` — the first one carrying the subpath. It cannot be raised in the pull request that adds it: `audit:plugin-compat` requires every `@guren/*` range to admit the version the workspace currently publishes, and that is still 2.13.0 until `changeset version` runs. So the edit belongs in the release pull request, beside the generated version bumps, and nothing catches it if it is skipped — the floor would then claim a compatibility this package does not have, and an install pinning an older `@guren/server` while upgrading `@guren/testing` alone would fail to resolve the deep import.
