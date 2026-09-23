---
'@guren/cli': minor
---

`guren introspect` prints the manifest of the registered, unbooted app (RFC 0026), as tables or with `--json`. It runs the app's `register()` and route registrars in a child process under `GUREN_INTROSPECT=1` and never runs `boot()` or `listen()`, resolves each routed controller to the file that exports it, and reports a failure as `no-entry`, `import`, `timeout`, `crashed` or `old-server`.
