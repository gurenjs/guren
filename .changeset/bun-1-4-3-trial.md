---
'@guren/cli': patch
---

CI now runs a non-blocking trial lane on Bun 1.4.3 beside the primary Bun 1.4.2. Bun 1.4.3 fixes CVE-2026-48618 (TLS certificate name matching in `fetch`, `https`, `tls.connect` and `Bun.connect`); Guren's own suite passes on it unchanged.
