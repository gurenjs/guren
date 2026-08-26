---
"@guren/testing": patch
---

Support multipart uploads in the controller test mock: `createControllerModuleMock()`'s `Controller` now implements `file()` and `files()`, and body parsing clones the request so `validateBody()` and `file()` compose on one multipart request — mirroring Hono's parse cache in the real runtime.
