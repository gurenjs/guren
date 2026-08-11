---
'@guren/cli': patch
---

Refuse plugin env entries that target the framework's own security gates

`guren plugin <pkg>` applies the `gurenPlugin.env` entries from the installed
package's manifest, and `applyEnvEntries` validated only the *shape* of the key
(`/^[A-Z][A-Z0-9_]*$/`). Values and comments were interpolated raw, so a
manifest could append `GUREN_TESTING=1` — which alone makes the server trust an
`X-Testing-User` header — or smuggle the same line through a newline inside an
innocuous entry's value, where a reviewer skimming key names would not see it.
`.env.example` is committed, so either line propagates to every clone.

Two refusals, both throwing rather than filtering in silence: keys in the
reserved `GUREN_*` namespace, and values or comments containing a line break.
A plugin has no legitimate reason to do either, so failing the install is the
right outcome; malformed keys keep their existing silent-skip behaviour.

The check runs as soon as the manifest is read — before the provider is wired
into `src/app.ts` and before any publish is written — so a refused manifest
does not leave a half-activated install behind. `applyEnvEntries` re-checks,
which covers any other caller.

This is hardening, not a fix for a confirmed exploit — the same command already
writes a provider import into `src/app.ts`, so a hostile package that reaches
this code path has other paths too.
