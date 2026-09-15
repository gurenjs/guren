---
'create-guren-app': patch
---

The blog starter's `PostController` reads the validated body of `posts.store`, `posts.update` and `posts.search` with `this.validated()` instead of validating it a second time.
