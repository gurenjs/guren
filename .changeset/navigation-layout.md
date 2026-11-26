---
"@guren/server": minor
"@guren/cli": minor
"create-guren-app": patch
---

`guren add auth` writes `config/navigation.ts` (Home, and Dashboard for signed-in users) and lists it in `createApp({ config })`, and the layout it writes renders the `navigation` prop instead of hard-coded links. The layout marks the current entry, wraps on a narrow screen, keeps Sign in, the profile link and Log out, reads their labels from `lang/en/layout.json`, and takes `wide` for a page that needs the wide measure. Its brand shows the new `app` shared prop, which the server sends once `config/env.ts` declares `APP_NAME`; an app sharing its own `app` prop keeps it. An existing `config/navigation.ts` or `lang/en/layout.json` is never replaced, and the Home entry is left out when no route is named `home`. The starter's `/` route is now named `home`.
