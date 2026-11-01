---
"create-guren-app": minor
---

The blog starter ships `.guren/forms.gen.ts`, the form contracts `guren codegen` writes for its `posts.store` and `posts.update` routes (RFC 0036). It imports `@guren/inertia-client/forms`, so the starter needs the `@guren/inertia-client` release that adds that subpath.
