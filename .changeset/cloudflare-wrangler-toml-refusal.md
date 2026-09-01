---
"@guren/plugin-cloudflare": patch
---

Refuse to build beside a wrangler config the plugin does not manage. wrangler resolves `wrangler.json` ?? `wrangler.jsonc` ?? `wrangler.toml` silently, so scaffolding `wrangler.jsonc` next to a lone `wrangler.toml` made wrangler stop reading the user's own config, and the build-owned key checks never ran on it. The build now fails up front with migration guidance when it finds a `wrangler.toml` (unreadable here) or a `wrangler.json` (outranks the managed file), and warns when a leftover `wrangler.toml` sits ignored beside `wrangler.jsonc`.
