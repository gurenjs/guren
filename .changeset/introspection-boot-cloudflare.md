---
'@guren/plugin-cloudflare': patch
---

The plugin's provider introspects through its own `introspect()` hook (RFC 0026), which binds nothing and reads no Workers binding.
