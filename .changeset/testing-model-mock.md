---
'@guren/testing': patch
---

Cover model declarations in the controller module mock.

`createControllerModuleMock()` stubbed `AuthenticatableModel` but not `defineModel`, so a controller test failed to even load when a model it imported used the function form — which `@guren/core` exports right alongside the class form. The stub also lacked the read/write entry points controllers reach for (`all`, `create`, `findOrFail`, `first`, `select`, `delete`); tests drive model behaviour by spying on those, and a spy cannot replace a method that was never defined.
