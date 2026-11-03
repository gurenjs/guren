---
'@guren/cli': patch
'create-guren-app': patch
---

A link inside a sentence is underlined. The harness rule `ui.md` now lists two text link styles: a link on its own (a nav item, "Back", "Edit") keeps `text-g-accent-text transition hover:underline`, and a link inside a sentence uses `text-g-accent-text underline underline-offset-2 transition hover:no-underline`, the string `make:auth` already writes, because color alone does not tell it apart from the words around it (axe's `link-in-text-block`). Run `bunx guren agent:sync` to pick up the rule. The blog blueprint's sign-in and sign-up pages, whose "Sign up" and "Sign in" links sat inside a sentence in color alone, now use the underlined style.
