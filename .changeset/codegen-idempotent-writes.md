---
'@guren/cli': patch
---

fix: skip rewriting generated artifacts whose content is unchanged

`guren codegen` wrote `.guren/pages.gen.ts`, `.guren/routes.gen.ts`,
`.guren/data.gen.ts`, `.guren/channels.gen.ts`, `.guren/api-client.gen.ts`,
and `types/generated/routes.d.ts` unconditionally, so every run bumped
their mtimes even when the output was byte-identical. Since the Vite plugin
regenerates on each save under `resources/js/pages/`,
`app/Http/Resources/`, and `routes/web.ts`, a frontend-only edit churned
files that backend code imports. The generators now compare the existing
file first and skip the write when nothing changed; content that differs
still goes through the usual `--force` guard.

As a consequence, `guren routes:types` without `--force` no longer errors
with "already exists. Use --force to overwrite." when the existing file is
already byte-identical to what it would generate — identical content is not
a clobber. Output that differs is still refused without `--force`.
