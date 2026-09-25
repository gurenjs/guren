---
'@guren/server': patch
---

A `config-unverified` manifest warning now carries the config's key as `key`, so a reader of `app.introspect()` can tell a config left unbound (it reads an environment variable that is not set) from a section the app does not configure (RFC 0026).
