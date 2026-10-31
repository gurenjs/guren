---
"@guren/cli": minor
"create-guren-app": patch
---

`guren upgrade` now keeps the Guren UI tokens in `resources/css/guren.css` current. The sheet's framework-owned part sits between `/* guren:tokens begin … */` and `/* guren:tokens end */` markers, and a new `guren-ui-tokens` doctor check reports when that block differs from the sheet the CLI ships; `guren upgrade` replaces the block and keeps every line outside it. A sheet with no markers is replaced only when it is byte-identical to one an earlier release wrote; an edited one is left alone, and doctor prints how to move its edits after the end marker. Broken markers (an open with no close, a close with no open, two blocks) are reported and nothing is written. New apps and `make:auth` / `make:feature` write the marked sheet.
