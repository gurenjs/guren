---
"@guren/cli": patch
---

**Scaffolded configs survive a blanked environment variable** — the generated configs selected a store, disk, transport, host or port with `process.env.FOO ?? 'default'`, which passes an empty string straight through. Blanking a key rather than deleting the line, or a hosting dashboard supplying a cleared variable, therefore named something that does not exist: `config/session.ts` failed the boot with `Session store not found:  (declared: memory)`, `CacheProvider` threw `Cache store not found:` on first use, `config/mail.ts` picked a transport called `''`, `StorageProvider` a disk called `''`, and `Number(process.env.SMTP_PORT ?? 587)` produced port **0** rather than 587. Each now uses `||`, which is what the fallback was written to mean.

`MAIL_FROM_NAME` and the credential variables keep `??`, where an empty value is a real choice rather than a missing one. `appendEnvEntry()` additionally refuses an entry that does not assign the key it is probed by, which would otherwise be re-appended on every run.
