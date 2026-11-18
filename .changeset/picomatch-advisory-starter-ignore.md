---
'@guren/cli': patch
'create-guren-app': patch
---

New apps ship a `config/audit.ts` that ignores GHSA-fc5q-39xc-vjpf, the picomatch `<=4.0.7` ReDoS that has no patched release yet. Exploiting it takes an attacker-chosen glob pattern, and Vite and the globbers it brings read their patterns from configuration only, so `guren audit` and `guren gate --deps` no longer fail a fresh app on it. The entry covers every copy of picomatch in the app, so delete it if your own code passes a glob from a request to picomatch or a globber. Otherwise delete it once `guren audit` reports it as unused, which happens when the lockfile resolves only picomatch releases outside the range; a fix being published is not enough while `bun.lock` still holds 4.0.7.

`guren audit` no longer reports a `deps:*` ignore entry as unused when the dependency scan did not finish (`--no-deps`, as `guren gate` runs it, or an unreachable registry), and a `deps:runtime:*`, `deps:runtime-scan` or `deps:runtime-unpinned:*` entry only once the Bun runtime check read every source.
