---
"@guren/cli": minor
---

Add accessibility checks to the generated browser specs (RFC 0033 §12.2). `guren add browser-tests` now installs `@axe-core/playwright` beside `@playwright/test` and writes `tests/browser/a11y.ts`, where an app disables rules or excludes selectors. Once both are present, `guren browser:map` keeps `tests/browser/generated/a11y.browser.ts`, which has one test per landmark and plan view and fails on any WCAG 2.0 to 2.2 A or AA violation, with axe's full result attached to the report. An app that already ran the blueprint runs it again to add them.
