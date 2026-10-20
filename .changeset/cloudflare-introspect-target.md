---
'@guren/plugin-cloudflare': minor
'@guren/cli': minor
'@guren/core': minor
---

The Cloudflare build judges its deploy-runtime checks on the branch the app takes on Workers (RFC 0035 §2.1). Under `GUREN_INTROSPECT=1` with `GUREN_INTROSPECT_TARGET=cloudflare`, `isWorkersRuntime()` returns true. The target variable alone does nothing, so an exported value cannot move `bun run dev`. `checkDeployRuntime(cwd, { target: 'cloudflare' })` introspects the app with that variable, and `reportDeployRuntimeHazards({ target })` passes it on. The evidence line names the branch the checks read (`as Cloudflare Workers runs it`). An ordinary introspection no longer inherits the variable from the calling shell. `guren doctor` and `guren check` keep judging the development branch. `guren introspect --target cloudflare` registers the app the same way. When that branch fails to register, the unverified checks name it as the command that reproduces the failure.
