---
"@guren/server": minor
"@guren/testing": minor
"@guren/core": patch
"@guren/orm": patch
"@guren/cli": patch
"@guren/openapi": patch
"@guren/inertia-client": patch
"create-guren-app": patch
---

First-class file uploads:

- **`this.file(name)` / `this.files(name)` controller helpers** — read uploaded files from multipart requests (null/empty-safe, composes with other body reads via Hono's cached parseBody). Previously controllers had to call `this.request.parseBody()` and duck-type the result.
- **`TestApp` accepts `FormData` bodies** — `csrf.post('/tasks/1/attachments', formData)` sends real multipart requests, so upload endpoints are finally testable.
