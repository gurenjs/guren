---
"@guren/cli": patch
---

`make:exception` now rejects a `--status` that is not an HTTP error code (400–599) instead of writing `super(NaN, message)`, and `make:test` reports an unknown `--runner` as a usage error instead of exiting the process from inside the command.
