---
'@guren/server': minor
---

Wire `TestRequestBuilder.withSession()` to server-side session hydration: the session middleware now reads the `X-Testing-Session` header — only when `GUREN_TESTING` is set, same gate as `X-Testing-User` — parses the JSON payload, and merges it over the stored session data for the request. Tests using `createTestClient(...).get(...).withSession({ ... })` now observe the injected session state instead of an empty session. Malformed or non-object payloads are ignored.
