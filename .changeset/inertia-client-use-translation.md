---
'@guren/inertia-client': minor
---

Add `useTranslation()` for the `_i18n` shared prop

Pages rendered by a server configured with `createApp({ i18n })` can now
translate on the client:

```tsx
import { useTranslation } from '@guren/inertia-client'

const { t, tc, locale } = useTranslation()
t('messages.welcome', { name: user.name })
tc('messages.items', items.length)
```

The hook reads the `_i18n` page prop (locale, fallback locale, and their
message catalogs) shared by the server. Translation semantics —
dot-notation keys, `:name`/`{name}` interpolation, `|`-separated plural
forms with per-locale rules, fallback-locale lookup, missing keys echoing
the key — mirror the server's Translator, held in sync by a parity test
that runs both implementations against shared fixtures. The pure
`createTranslator()` is exported for use outside components. When the
`_i18n` prop is absent the hook returns keys untranslated and warns once.
