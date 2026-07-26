---
'@guren/testing': patch
---

`createControllerModuleMock()` now exports `ServiceProvider` and `defineModule`.

A module's `index.ts` calls `defineModule()` and lists providers that extend
`ServiceProvider`, and both run at import time. A controller test whose subject
reached a module's public surface therefore failed to load with
`No "ServiceProvider" export is defined on the "@guren/core" mock`, unless the
test spread its own stand-ins over the mock.
