---
'@guren/cli': patch
---

The `config/cache.ts` definition that `guren add cache` writes now checks at boot that `CACHE_STORE` names a declared store, as the queue, mail and storage definitions already do. An undeclared name used to pass the boot and throw on the first cache call.
