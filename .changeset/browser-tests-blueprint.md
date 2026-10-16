---
"@guren/cli": minor
---

`guren add browser-tests` sets up Playwright browser tests (RFC 0033 §6). The config starts the app through `guren browser:serve --port 4317`, so every run passes its production and local-database checks, and stops it with SIGTERM. The generated specs under `tests/browser/generated/` check each feature's landmark and, for every approved plan with views, the form labels and action names on the page that renders each view; a re-run rewrites them after a plan is approved. Where the app signs in with a password it also writes a setup project and `db/seeders/browser-account.ts`, which seeds one account from `BROWSER_TEST_PASSWORD` only for an app `browser:serve` started, never in production. Spec files end in `.browser.ts`, since `bun test` collects `*.spec.ts`, and `guren gate` does not run them.
