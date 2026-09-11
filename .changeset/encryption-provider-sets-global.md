---
"@guren/server": patch
---

Register the container's Encrypter as the global one at boot

`EncryptionServiceProvider` bound an `encrypter` singleton but never called
`setEncrypter()`, so the exported `encrypt()` / `decrypt()` / `getEncrypter()`
threw "Encrypter not initialized" in every app that registered the provider.
The provider now sets the global from the bound instance in `boot()`, so the
functional API and `container.make('encrypter')` share one encrypter.

The container's encrypter becomes the global one at boot, replacing an encrypter
the app set with `setEncrypter()` itself before booting.
