---
'@guren/plugin-cloudflare': patch
---

Make the wrangler config upgrade warning reach commented configs, and suggest entries rather than whole keys

`cloudflare:build` never overwrites an existing `wrangler.jsonc`; instead it warns
about the keys it owns that the config is missing — notably the `alias` entries,
without which `wrangler deploy` cannot resolve the stubbed modules. Two things
kept that warning from doing its job.

It read the file with `JSON.parse`, so any config carrying a comment failed to
parse and the check bailed silently. Comments are the normal case in a `.jsonc`
file, which meant the warning could not fire for the apps it exists to help: they
saw nothing at build time and a resolution failure at deploy time instead. The
config is now read with a JSONC-tolerant parser (comments and trailing commas,
string-aware so a `//` inside a value survives), and a file that is still
unparseable afterwards is reported rather than skipped.

The warning also printed `alias` and `define` as complete objects holding only
the build-owned entries, which reads as something to paste over what the file
has. Apps keep their own entries under both keys, so following it could drop a
pinned dependency alias or a second `define`. It now names only the individual
entries that are missing, and says to add them alongside what is already there.
