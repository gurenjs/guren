---
'@guren/cli': patch
---

`guren deploy --target docker` writes a Dockerfile whose image runs. The production stage now copies `tsconfig.json` and `lang/`: without the first, a scaffolded app exited at startup on `Cannot find module '@/.guren/pages.gen'`, because Bun resolves the `@/` alias from `tsconfig.json`; without the second, i18n rendered raw keys such as `messages.welcome`. It also copies `modules/`, which `make:module` creates.

The API-only blueprint's image did not build at all: it has no `.guren/`, `public/` or `lang/`, and a `COPY` of a missing source fails. The builder stage now creates every runtime directory before the production stage copies them. Regenerate an existing Dockerfile with `guren deploy --target docker --force`.
