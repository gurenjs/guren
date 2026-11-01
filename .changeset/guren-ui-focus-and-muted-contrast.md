---
"@guren/cli": patch
"@guren/server": patch
"create-guren-app": patch
---

Text inputs, textareas and selects now show a focus ring. Under Tailwind v4, `outline-none` sets the outline style to `none` and `focus:outline-2` only sets the width, so a focused field had no outline, and `focus:border-transparent` hid its border as well. The `Input`, `Textarea` and `Select` components (now v2) and the `ui.md` harness rule use `focus:outline-solid focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent` and keep the border, and the blog starter's post forms use the components instead of a copied class string. `guren upgrade` updates unedited copies of the three components and the token block only: pages generated before this release (`make:auth` and `make:feature` output, the blog starter's pages) still carry `focus:border-transparent focus:outline-2`, so replace it there with `focus:outline-solid focus:outline-2`.

`--g-muted` now meets WCAG AA for text: `#6b7280` in light mode (4.67:1 on `--g-raised`, was 2.46:1) and `#8d89a7` in dark mode (4.52:1 on `--g-raised`, was 2.94:1). Dark `--g-text-2` moves to `#aeabc9` so secondary text stays distinct from muted text (1.51:1 apart, as light mode's 1.56:1). The docs viewer, Dev Center, plan page and the error and debug pages carry the same values.
