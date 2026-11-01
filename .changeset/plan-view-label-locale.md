---
'@guren/cli': minor
---

`guren check --plan` warns about an open plan whose `locale` is another language than the app's default locale (`createApp({ i18n })`) and whose views carry form field or action labels. Those labels are the text the page shows, which the browser specs look for on a page rendered in the default locale, so they are written in that locale whatever the language of the rest of the plan. The producer prompt (`guren plan --print-prompt`) now says so.
