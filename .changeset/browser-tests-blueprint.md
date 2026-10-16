---
"@guren/cli": minor
---

`guren add browser-tests` sets up Playwright browser tests (RFC 0033 §6). `playwright.browser.config.ts` starts the app through `guren browser:serve --port 4317`, so every run passes its production and local-database checks, and stops it with SIGTERM; an existing Playwright config is left alone. Where the app signs in with a password it also writes a setup project and `db/seeders/browser-account.ts`, which seeds one account from `BROWSER_TEST_PASSWORD` only for an app `browser:serve` started, never in production. From then on `guren browser:map` keeps the specs under `tests/browser/generated/`: one per feature's landmark and, for every approved plan with views, the form labels and action names on the page that renders each view, with `--check` reporting a stale one. Spec files end in `.browser.ts`, since `bun test` collects `*.spec.ts`, and `guren gate` does not run them.
