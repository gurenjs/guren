---
'@guren/cli': patch
'create-guren-app': patch
---

New apps ship a `config/audit.ts` that ignores GHSA-fc5q-39xc-vjpf, the picomatch `<=4.0.7` ReDoS that has no patched release yet. Exploiting it takes an attacker-chosen glob pattern, and Vite and the globbers it brings read their patterns from configuration only, so `guren audit` and `guren gate --deps` no longer fail a fresh app on it. Delete the entry once picomatch ships a fix: `guren audit` then reports it as unused.

`guren audit` no longer reports a `deps:*` ignore entry as unused when the dependency scan did not finish (`--no-deps`, as `guren gate` runs it, or an unreachable registry), and a `deps:runtime:*` entry only once the Bun runtime check read every source.
