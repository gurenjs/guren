---
'@guren/core': patch
---

The deploy builds' runtime check (`@guren/core/internal/deploy-check`) now judges from the introspected app where `@guren/cli` can introspect it, and from the source scan otherwise (RFC 0026 Part 2a). It still only warns.
