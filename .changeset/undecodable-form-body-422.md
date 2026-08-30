---
"@guren/server": patch
"@guren/testing": patch
---

A request body the form parser cannot decode fails validation instead of crashing the request.

Sending a body the form parser rejects — a `Content-Type: multipart/form-data` with no usable boundary, say — used to get a different answer depending on which validation path read it. A route contract and the `validateRequest()` / `validateRequestWith()` middleware let the parser's `TypeError` escape, so the client got a **500** whose body reported the exception and a stack trace; `Controller.validateBody()` caught it and validated `{}` instead. Three readers of the same request, three answers.

A malformed body is a client error, so it is now treated as one: the parse step falls back to `{}` and the schema decides, which puts it alongside every other body-validation failure — a 422 for any schema that rejects `{}`. The fallback lives in `parseRequestBody()`, which is also what `parseRequestPayload()` reads, so the field-by-field callers stop throwing on one too: `Controller.input()` / `only()` / `except()` / `has()`, `FormRequest` rules, and broadcast channel authorization, which answers its usual 400 (`No channel specified`) rather than a 500.

**This changes a status code.** A client branching on 500 for a malformed form body now sees whatever its schema decides — 422 for the common case. The response body is the ordinary validation-error shape rather than an exception report; leaking the parser's message and stack to the client was itself part of the old behavior.

Two things this deliberately does not change. An all-optional object schema keeps *passing* on an undecodable body, because the fallback is `{}` and not `undefined` — the same answer it has always given for an empty POST or malformed JSON. And it covers the paths that hand the body to a schema, not every read of one: CSRF token extraction catches the parser's error itself and fails closed at 403, unchanged. `Controller.file()` / `files()` parse the multipart body themselves rather than through this fallback, and get their own guard — see the accompanying note.

`Controller.getRawBody()` drops its own now-redundant fallback and reads the shared one. `@guren/testing`'s controller mock does the same, and its parser's fallback now covers the whole body read rather than one content type, so the mock and the runtime give the same answer for an undecodable body. A ctx carrying no request at all still throws there rather than reading as `{}` — that is a broken test setup, not an unparseable body.
