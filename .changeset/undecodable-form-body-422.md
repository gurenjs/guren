---
"@guren/server": patch
"@guren/testing": patch
---

A request body the form parser cannot decode is a 422, on every path that parses one.

Sending a body the form parser rejects — a `Content-Type: multipart/form-data` with no usable boundary, say — used to get a different answer depending on which validation path read it. A route contract and the `validateRequest()` / `validateRequestWith()` middleware let the parser's `TypeError` escape, so the client got a **500** whose body reported the exception and a stack trace; `Controller.validateBody()` caught it and validated `{}` instead. Three readers of the same request, three answers.

A malformed body is a client error, so it is now treated as one everywhere: the parse step falls back to `{}` and the schema decides, which means 422 alongside every other body-validation failure. The fallback lives in `parseRequestBody()`, the single point all of them reach it through, so this covers more than those three: `parseRequestPayload()` and everything reading the body field by field through it — `Controller.input()` / `only()` / `except()` / `has()`, `FormRequest` rules, and broadcast channel authorization — no longer throw on one either. Broadcast authorization answers its usual 400 (`No channel specified`) rather than a 500.

**This changes a status code.** A client branching on 500 for a malformed form body now sees 422, and the response body is the ordinary validation-error shape rather than an exception report. Note that leaking the parser's message and stack to the client was itself part of the old behavior.

An empty-object fallback rather than `undefined` is the deliberate half: an all-optional object schema keeps passing on an undecodable body, exactly as it does on an empty POST. A body that decodes is untouched.

`Controller.getRawBody()` and `@guren/testing`'s controller mock drop their own now-redundant fallbacks and read the shared one, so the mock and the runtime keep giving the same answer here.
