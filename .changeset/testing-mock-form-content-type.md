---
"@guren/testing": patch
---

Fix the controller mock recognizing form `Content-Type`s differently from the runtime.

The mock gated its urlencoded and multipart branches on `contentType.includes(...)`. The runtime has no form branch of its own: everything non-JSON reaches Hono's `parseBody()`, which takes `split(';')[0].trim().toLowerCase()` and compares the media type exactly, answering `{}` for anything else.

A substring test is wrong in both directions, so the mock both missed bodies production parses and parsed bodies production ignores. Measured with body `a=hit`, asking for `this.input('a')`:

| `Content-Type` | runtime | mock (before) |
| --- | --- | --- |
| `application/x-www-form-urlencoded; charset=UTF-8` | `"hit"` | `"hit"` |
| `Application/X-WWW-Form-Urlencoded` | `"hit"` | `null` |
| `application/x-www-form-urlencoded-evil` | `null` | `"hit"` |

The mock now applies Hono's normalization and exact match. The JSON branch deliberately stays `includes('application/json')`, because the runtime spells that one the same way — tightening it here would introduce a divergence rather than remove one.

`packages/testing/tests/controller.test.ts` pins all four cases by running the same request through the mock and through a real `Application.fetch()` controller, including the parameterized spelling browsers actually send, so the normalization cannot regress into a bare equality check.
