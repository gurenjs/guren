---
"@guren/inertia-client": minor
---

`useField` (and so the copied `Field` component) resolves a label it is not given from the app's translations (RFC 0036 §4): `fields.<route>.<name>.label`, then `fields.<name>.label`, both in the current locale before the fallback locale, then the field name as words. An enum's option labels read `fields.<name>.options.<value>` the same way; a value or field name containing a dot has no key and reads as words. The `_i18n` page prop is read without the warning `useTranslation()` prints, so an app without i18n sees no change. `hasTranslation(i18n, key)` is exported beside `createTranslator()` and reports whether a key exists in the current locale or its fallback, which `t()` cannot tell apart from a key translated as itself.
