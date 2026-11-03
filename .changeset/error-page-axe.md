---
'@guren/server': patch
---

The built-in error page (403, 404 and every other status) and the development debug page now pass axe. The error page's large status numeral is set in `--g-muted` instead of `--g-line-strong`, which measured 1.47:1 on the light page and 1.64:1 on the dark one, below the 3:1 large text needs; it now measures 4.83:1 and 5.09:1. Both pages put their content inside a `<main>` landmark. The debug page dims a stack frame from `node_modules` by setting its text in `--g-muted` rather than fading it with `opacity: 0.5`, which took the frame's location text to 2.34:1.
