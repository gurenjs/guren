---
"@guren/cli": minor
---

`guren browser:map` keeps behaviour specs under `tests/browser/behaviours/generated/` (RFC 0033 §13.5), for an app that declares `e2e` and `@e2e-dev/web` and has `e2e.browser.config.ts` and `tests/browser/behaviours/given.ts`. Each `success` or `validation` behaviour of an approved plan that a view of the plan sends becomes one e2e test: it opens the start page, performs the behaviour with the runner's locators where the plan names every control it touches (a labelled text, number, checkbox or select field of the submitting form, and an action for the route), otherwise in one agent step built from the plan's input and the view's labels, and pins the outcome with locators. A locator step needs no recording and no model. A behaviour it cannot write is a skipped test naming why. Nothing writes that config or `given.ts` yet: `guren add browser-tests --behaviours` follows, and until it ships an app that has neither sees no change.
