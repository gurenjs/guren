---
'@guren/cli': minor
---

`guren plan:render` writes a page that speaks `en` and `ja`. Both dictionaries are
embedded in the file, so the page switches between them with no request, and
remembers the choice. `--locale <en|ja>` picks the language it opens in; without
it the plan's `locale` decides, then the application's `createApp({ i18n })`
fallback, then `en`.

Only the page's own words are translated: section names, labels, review controls
and the sentence frames around plan data (`{actor} が {route} を呼ぶ`). Plan text,
check results and the column fact line (`pk`, `null`, `references`) stay as
written. `<html lang>` follows the plan, and every translated element carries the
`lang` of the language it is in.

`planBreakingChanges()` results gain `reasonKey` and `reasonValues` beside the
English `reason`, which is how the page words a breaking change in either language.
