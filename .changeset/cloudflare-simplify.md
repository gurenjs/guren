---
"@guren/plugin-cloudflare": patch
---

`cloudflare:build --report-size` on a `cf`-backend app now fails before the build with a message that names the flag and says to drop it. `package.json` is read through one helper, which treats a non-string `scripts` or dependency entry as absent.
