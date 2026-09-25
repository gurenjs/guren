---
'@guren/core': patch
---

The deploy builds' runtime check (`@guren/core/internal/deploy-check`) now judges from the introspected app where `@guren/cli` can introspect it, and reports the hashing and store verdicts unverified otherwise (RFC 0026 Parts 2a and 3). Before the warnings it prints one line naming what each verdict was judged from, with the reason when the app could not be read. It still only warns.
