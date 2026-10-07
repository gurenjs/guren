---
"create-guren-app": patch
---

Write the post's author through `Post.create(data, { set: { authorId } })` in the blog template, so the validated body keeps `fillable` filtering instead of passing through `forceCreate` (RFC 0031).
