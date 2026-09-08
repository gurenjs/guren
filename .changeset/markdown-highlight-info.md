---
'@guren/plugin-markdown': minor
---

`createMarkdownRenderer`'s `highlight` callback now receives the fence's whole
info string as a third argument, beside the language it already got. A fence
that carries attributes after the language (```` ```ts file=app/Models/Post.ts ````)
can then be rendered differently without parsing the markdown a second time.
Existing highlighters take two arguments and are unaffected.
