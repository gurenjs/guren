---
'@guren/server': minor
---

`recordEnvReads(values)` returns the environment wrapped so that every key a `resolve()` reads is recorded (RFC 0027 §2). `ConfigServiceProvider` resolves each definition through it and leaves unbound any definition that read a key the environment does not set, rather than handing a manager constructor the redacted placeholder. Only reachable under `GUREN_INTROSPECT=1`, since an unset key otherwise fails the boot.
