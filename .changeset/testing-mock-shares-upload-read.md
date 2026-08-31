---
"@guren/server": minor
"@guren/testing": minor
---

Stop `@guren/testing`'s controller mock keeping its own copy of the multipart upload read.

This is the follow-up the body-parser change filed. That one moved `validateBody()` and the field helpers onto the runtime's parser and left exactly one restatement behind: `file()` and `files()` do not go through the body parser, so the mock still gated on Hono's media-type rule and then read the body with `Request.formData()`.

`Controller.parseUploads()`'s body moves to `parseRequestUploads(ctx)` in `packages/server/src/http/request.ts`, re-exported from the internal `@guren/server/internal/request` subpath beside `parseRequestBody`. `Controller.file()` / `files()` call it, and the mock calls it through the same `HonoRequest` adapter the body parser already uses — so the mock's `isMultipartBody` and `readMultipartBody` are gone, and the adapter is now the whole of what stays local.

It is a second function rather than a second caller of `parseRequestBody`, deliberately: uploads parse with `{ all: true }`, so a field repeated in the body stays an array and `files()` sees every part. The body parser flattens that same field to its first value, so routing uploads through it would silently reduce `files()` to one file per `<input multiple>` — a loss no malformed-body test can see.

**The divergence this closes, and where it is visible.** The mock answered `null` from `file()` for a `Content-Type: MULTIPART/FORM-DATA` body the runtime delivers the file for. The gate was not the cause: it lowercases like Hono does. `Request.formData()` was — it is case-sensitive on Bun, where Hono lowercases the media type before parsing, so the gate passed and the read then threw. Measured on both runtimes: Node's `formData()` is case-insensitive, so a controller test run under vitest could not see this. Nothing gates now, on either side, because Hono decides the media type inside `parseBody()`.

**`readMultipart()` changes shape, and this is the deliberate part.** It is public only because TS4094 forbids private members on the exported anonymous class type the mock factory returns, but it appears in the published `packages/testing/dist/index.d.ts`, so the change is stated here rather than left to ride. Two things change together:

- Its return type goes from `Promise<FormData | null>` to `Promise<Record<string, string | File | (string | File)[]>>` — the runtime's `{ all: true }` record. The `multipartBody` memo beside it follows.
- `null` is gone. A non-multipart body now reads back as its parsed fields rather than as `null`, because the runtime has no media-type gate to answer `null` from.

`file()` and `files()` are unaffected by both: a urlencoded field arrives as a string and fails their `instanceof File` test exactly as an absent field does. Only a caller reaching for `readMultipart()` itself is affected, and nothing in this repository does.

One knock-on is worth naming because it lands on the published surface. Both members are typed as `RequestUploads`, so `packages/testing/dist/index.d.ts` now opens with `import { RequestUploads } from "@guren/server/internal/request"` — a *type*-level dependency on that subpath, where the previous release only reached it at runtime. Naming the runtime's type rather than respelling its shape is the point, and it makes the version floor below a compile-time check instead of a runtime one: a consumer on a `@guren/server` too old to carry the subpath now fails to typecheck rather than failing on first import. That is strictly the better failure, but it does mean the release step below is load bearing for typechecking too, not only for resolution.

The precedent here is the opposite of the one set when the mock's `parsedBody` box was reverted to keep the published shape. That break was avoidable — the mock clones the request, so re-parsing cost nothing and the memo could stay as it was. This one is not: `FormData | null` *is* the second implementation. Keeping it would mean converting the runtime's record back into a `FormData`, which reintroduces the copy this removes. `createControllerModuleMock()`'s members are Experimental by the decision tree in `contributing/api-stability.md` — exported from the package index, not from `@guren/core`, with no stability annotation on the package — which is what allows a minor here.

`packages/testing/tests/controller.test.ts` gains an upload table beside the body one, running `file()` and `files()` through a real `Application.fetch()` controller and a mocked one on the same request: a single upload, an uppercase media type, a repeated file field, a repeated `field[]`, a leading empty upload, a multipart text field, a urlencoded body, and a body with no boundary. Both sides must answer the same names.

What that table can and cannot do is worth stating, because it was measured rather than assumed. Dropping `{ all: true }` turns two rows red, which is the guard it is really carrying. But run against the exact pre-change mock, **every row passes** — including the uppercase one, because vitest runs that suite on Node, whose `formData()` is case-insensitive. So the assertion that can actually fail on the uppercase axis lives in `packages/server/tests/http/request.test.ts`, which runs under `bun run test:bun` on the one runtime that can see it; it also pins its own premise, asserting that `Request.formData()` rejects that header before asserting that `parseRequestUploads` does not. The table's job is to keep the mock pinned to the runtime as the runtime's read changes, and the mutation above shows it doing that.

`@guren/server` gains one function on the existing internal subpath — no behavior change, and nothing new on the package root. The subpath carries no stability guarantee, by the same rules that put `parseRequestBody` on it.

**Release step:** the same one the change that added the subpath already carries, and nothing new — `@guren/testing`'s required `@guren/server` peer must be raised from `>=2.2.0` to the version this release publishes for `@guren/server`, in the release pull request beside the generated version bumps. It cannot be raised earlier: `audit:plugin-compat` requires every `@guren/*` range to admit the version the workspace currently publishes. What is new is the consequence of skipping it. It was already an unresolvable deep import at runtime; with `RequestUploads` on the published type surface it is now also a typecheck failure in any consumer of `@guren/testing` that pins an older `@guren/server`.
