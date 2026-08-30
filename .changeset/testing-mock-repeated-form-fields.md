---
"@guren/testing": patch
---

Fix the controller mock reading repeated form fields differently from the runtime.

`createGurenControllerModule()`'s `parseRequestPayload` built urlencoded bodies with `Object.fromEntries(new URLSearchParams(text))` and multipart bodies with `formData.forEach((value, key) => { result[key] = value })`. Both keep the **last** value of a repeated field, so for `tags[]=core&tags[]=framework` the mock's `this.input('tags[]')` returned `"framework"` while the runtime returned `"core"` — a controller test could pass on behavior production does not have.

The rule the mock now mirrors is Hono's, not a blanket "first value wins". `parseBody()` collects every value only for a `[]`-suffixed key (its `shouldParseAllValues`), and the runtime's `parseRequestPayload` then flattens the result with `Array.isArray(v) ? v[0] : v`. So the observable contract is: a `[]`-suffixed key keeps the **first** value, and any other repeated key keeps the **last**. The mock previously agreed with the runtime on the plain key and diverged only on the bracketed one; making it first-wins for both would have fixed `tags[]` while newly breaking `tags`.

Both content types now go through one shared rule, which collects into a `Map` and materializes with `Object.fromEntries` rather than assigning into an object literal: `result['__proto__'] = v` hits the inherited setter and drops the field, where the runtime keeps it as an own property. And `packages/testing/tests/controller.test.ts` pins all four combinations ({urlencoded, multipart} × {`tags[]`, `tags`}) by running the same body through the mock and through a real `Application.fetch()` controller, so the two cannot drift apart again.
