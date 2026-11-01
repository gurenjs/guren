---
"@guren/cli": patch
"create-guren-app": patch
---

Text inputs, textareas and selects show their focus ring again. Under Tailwind v4, `outline-none` sets the outline style to `none` and `focus:outline-2` only sets the width, so a focused field had no outline, and `focus:border-transparent` hid its border as well. The `Input`, `Textarea` and `Select` components (now v2), the blog starter's post forms and the `ui.md` harness rule use `focus:outline-solid focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent` and keep the border. `--g-muted` is darkened to meet WCAG AA for text: `#6b7280` in light mode (4.67:1 on `--g-raised`, was 2.46:1) and `#8d89a7` in dark mode (4.52:1 on `--g-raised`, was 2.94:1). `guren upgrade` updates unedited copies of the three components and an unedited token block.
