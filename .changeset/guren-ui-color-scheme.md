---
"create-guren-app": patch
"@guren/cli": patch
---

**The Guren UI token sheet declares `color-scheme`** — `resources/css/guren.css` defined a full dark palette behind `@media (prefers-color-scheme: dark)` but never told the user agent about it, so under a dark system preference the scrollbars, native form controls and Chrome's autofill highlight kept rendering light against the dark `--g-page` ground. `:root` now carries `color-scheme: light dark`, which follows the same preference the palette does. Scaffolded apps pick it up from the template; an existing app copies the one declaration into its own `resources/css/guren.css` by hand, since `make:auth` and `make:feature` never overwrite a sheet that is already there.
