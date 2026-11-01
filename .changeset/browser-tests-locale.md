---
"@guren/cli": minor
---

`guren add browser-tests` pins the browser run to the app's default locale (RFC 0036 §5). The Playwright config sets `locale` to the default read from `createApp({ i18n })` (`en` when it cannot read one), the setup project clears the `locale` cookie before saving the signed-in session, and the plan specs `guren browser:map` writes check that the page's `_i18n.locale` equals `_i18n.fallbackLocale` before asserting labels.

The config and `tests/browser/auth.setup.ts` are written once, so an app that already ran the command gets only the spec check. To pin it too, add `const LOCALE = '<default>'` and `locale: LOCALE` under `use` in `playwright.browser.config.ts`, and `await page.context().clearCookies({ name: 'locale' })` before `storageState()` in `auth.setup.ts` (Playwright 1.43 or later), or rerun the command with `--force`, which also rewrites `tests/browser/support.ts` and `tests/browser/a11y.ts`.
