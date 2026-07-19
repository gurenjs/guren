---
'@guren/server': minor
---

Add `InertiaOptions.lang` so controllers can localize the root `<html lang>` attribute, e.g. `this.inertia(page, props, { lang: 'ja' })` for Japanese pages. Defaults to `"en"`.
