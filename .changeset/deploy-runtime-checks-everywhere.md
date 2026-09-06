---
'@guren/cli': minor
'@guren/core': minor
'@guren/plugin-cloudflare': minor
'@guren/plugin-lambda': minor
'@guren/plugin-vercel': minor
---

Run the deploy-runtime checks where builds run, not only in `guren doctor` (RFC 0020 Part 0)

An app that keeps sessions in `MemorySessionStore` works on one Bun server and
loses every login on Cloudflare Workers, Lambda, or Vercel, where requests share
no memory. `guren doctor` has reported that, along with a Bun-only
`ScryptHasher` and filesystem provider discovery, but nothing in the path to a
deploy ran `doctor`.

- `guren check` now reports the same three verdicts for an app that declares a
  deploy plugin or the Lambda adapter, as advisory results: they print in the
  report and in `--json`, and `check --ci` and `guren gate` never fail on them,
  because the scan reads constructions rather than intent (a custom
  `SessionStore` passed as `store:` reads as unbacked). Apps with no deploy
  target see nothing new.
- `cloudflare:build`, `lambda:build`, and `vercel:build` print the failing
  verdicts before the app build, prefixed with the build's label, and go on to
  build. A scan that cannot run says so in one line rather than staying silent.
- `@guren/cli` exports `analyzeDeployRuntime`, `judgeDeployRuntime`, and
  `checkDeployRuntime`; `@guren/core/internal/deploy-check` exports
  `reportDeployRuntimeHazards`, the helper the three builds share. `doctor`'s
  output is unchanged: it maps the same verdicts onto its checks.
