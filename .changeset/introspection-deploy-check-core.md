---
'@guren/core': patch
---

The deploy builds' runtime check (`@guren/core/internal/deploy-check`) now judges from the introspected app where `@guren/cli` can introspect it, and from the source scan otherwise (RFC 0026 Part 2a). Before the warnings it prints one line naming what each verdict was judged from, with the reason when the app could not be read. It still only warns.
