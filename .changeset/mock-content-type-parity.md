---
"@guren/testing": patch
---

Match the runtime's `Content-Type` rule in the controller mock's body parsing.

The mock gated its form branches on a case-sensitive `contentType.includes(...)` substring test, while the runtime reaches form bodies through `ctx.req.parseBody()`, which compares the media type — `Content-Type` up to the first `;`, trimmed and lowercased — with `===`. The substring test diverged in both directions: `Application/X-WWW-Form-Urlencoded` and `Multipart/Form-Data; boundary=…` were ignored by the mock and parsed by the runtime, and `application/x-www-form-urlencoded-evil` was parsed by the mock and ignored by the runtime. Either way a controller test could pass on behavior production does not have. The same gate sits in front of `file()`/`files()`, so a mixed-case multipart upload read as `null` in the mock while the runtime delivered the file.

Both gates now apply the media-type rule. The JSON branch deliberately keeps its case-sensitive `includes('application/json')`: the runtime reaches `ctx.req.json()` through exactly that test, so `application/json-evil` is read as JSON and `Application/JSON` is not, in the mock and the runtime alike. All three are now pinned by tests that run one request through the mock and through a real `Application.fetch()` controller and assert both the agreement and the concrete value, alongside tests that pin where a malformed body is swallowed.
