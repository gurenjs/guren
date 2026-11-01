---
"@guren/cli": minor
"create-guren-app": minor
---

Add `guren add ui`, which copies token-styled React components into `resources/js/components/ui/`: `Button` (with `buttonClass()` for a link styled as a button), `Label`, `Input`, `Textarea`, `Select`, `Checkbox`, `Card` and `Alert`. The app owns the copies, so a design change edits one file instead of every page. A re-run writes only the missing components; `--diff` prints a copy against the current template and `--force` replaces it.

`make:feature` and `make:auth` now render their pages with these components and copy any the app lacks, never touching one it has. The wiring is unchanged (`useForm`, the `useId()` field ids, the raw field name as label). New apps from `create-guren-app` ship the components, and the default home page and the blog template's auth and profile pages use them.

A new `guren-ui-components` doctor check reports a copy that an earlier release wrote and `guren upgrade` replaces it with the current template. A copy that matches no released template (edited, or reformatted) is reported with the `guren add ui <name> --diff` command and left alone.
