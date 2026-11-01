---
'@guren/cli': patch
'create-guren-app': patch
---

Generated and scaffolded forms render `method="post"` and an `action` naming their route. A form submitted before React hydrated (common in dev while Vite optimizes dependencies) was a native GET, which put every named field in the URL, the password on the sign-in page included, and so in access logs and browser history. It is now a plain POST to the route. This covers the sign-in, registration, password reset, email verification and profile pages `guren add auth` writes, the New and Edit pages `make:feature` writes, and the same pages in the `blog` starter. Forms for a PUT or PATCH route also say `post`, since HTML forms send only GET and POST; the hydrated page still submits with the route's own method.
