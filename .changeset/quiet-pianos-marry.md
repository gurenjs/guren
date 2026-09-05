---
"@guren/cli": minor
---

Report CSRF exemptions in `guren audit`

`Application.declareCookielessAuthPath()` exempts a path from CSRF
verification. It is public, so any installed package can call it — and a call
made from `node_modules` is invisible to review: the audit's source scan never
reads there, and no CLI command can observe the runtime set, because nothing in
the CLI boots an application.

`guren audit` now reports both sides.

- **Application CSRF exemptions** warns on a call in the app's own source. An
  app author's lever is `csrfOptions.exclude`, which reads as a decision the app
  made; suppress with `// guren-audit-ignore` where the framework method is
  genuinely right.
- **Plugin CSRF exemptions** reads the JavaScript each Guren-facing dependency
  ships (one that declares a `gurenPlugin` manifest, or depends on
  `@guren/core`/`@guren/server`) and names every package that declares one.
  A package outside the `@guren/` scope is a warning; first-party packages are
  listed without one. It names packages, never paths — each path is an argument
  computed at boot from that package's own configuration, so no static read can
  know it.

A dependency that is installed but unreadable is its own warning, and
`csrfExemptionScan.status` in `--json` reports `partial`, so a directory that
would not open never reads as a clean scan.
