---
"@guren/core": patch
"@guren/plugin-cloudflare": minor
"@guren/plugin-vercel": minor
---

Carry the static-document download policy onto Cloudflare Workers and Vercel.

Files a browser renders as a document — `.html`, `.htm`, `.svg`, `.xhtml`,
`.xml` — are served from `public/` with `Content-Disposition: attachment` and
`X-Content-Type-Options: nosniff`, so navigating straight to one downloads it
instead of running its script on the app's origin. On both of these deploy
targets the platform answers for `public/` before the app runs, so the
framework's guard never saw those requests: the same app downloaded an SVG
locally and rendered it inline in production.

Each plugin now declares the policy to its platform at build time, keyed on
file extension because the platform, not the app, computes the content type.
The Cloudflare build writes a `_headers` file into the staged asset directory,
keeping and going ahead of any `_headers` the app ships under `public/`. The
Vercel build adds the rule to the generated `config.json` after
`handle: "hit"`, which confines it to files the CDN answered — in the initial
phase it would also have forced a download on a path the function serves, such
as a dynamic `/sitemap.xml`.

The Cloudflare scaffold additionally sets `"html_handling": "none"` on the
`assets` binding. Under the platform default a staged `page.html` is served at
`/page` and `/page.html` merely redirects there, which both leaves the `.html`
rule landing on the redirect rather than the document and lets a file under
`public/` shadow an app route of the same name. An app that names another
`html_handling` itself is left alone; an existing `wrangler.jsonc` with no
value is named in the build's upgrade warning.

`inlineDocuments` does not reach either plugin — they read a built directory,
not the app's route configuration. The deployment guides say so and describe
how to undo the platform-side rules after a build.
