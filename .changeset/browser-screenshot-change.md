---
"@guren/cli": patch
---

`guren browser:record --close` now compares each screenshot with the latest earlier run of the same feature that recorded the same step and file name (RFC 0033 §12.3). The step record keeps the pairing as `cli.screenshots[].previous`, and stderr says per screenshot whether it is unchanged, changed (with both paths), changed at the same commit, or new, plus how many earlier runs could not be read. The comparison never changes a step's result. The `verify-in-browser` skill now asks for screenshots named after the state they show and treats a change as a prompt to look.
