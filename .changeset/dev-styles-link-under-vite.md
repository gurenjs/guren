---
'@guren/server': patch
---

Stop linking the raw dev stylesheet when a Vite dev server owns the entry

In development the Inertia document linked `/resources/css/app.css` — the
*source* file, served raw by the app server. With Tailwind in it (every
scaffolded app), the browser then requests the bare `@import 'tailwindcss'`
specifier as a relative URL, 404s, and logs a MIME-type console error on every
page load. The link contributed nothing: the compiled CSS already arrives
through Vite's module graph via the `app.tsx` import.

The document renderer now drops exactly that dev-default path when the script
entry is served from a dev server (an absolute http(s) URL). Explicitly
configured stylesheet hrefs are left alone, fallback mode (no Vite; the entry
served same-origin) keeps the link — there the raw file is the only styling —
and production manifest-derived links are untouched.
