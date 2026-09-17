---
"@guren/testing": minor
---

`fakeAi()` scripts embeddings and images (RFC 0029 Part 3):
`respondEmbeddings()` takes a queue drawn one vector per value, or a function
answering every value; `respondImages()` takes one entry per `image()` call.
`embedCalls()` / `imageCalls()` read them back, and `assertEmbedded`,
`assertNeverEmbedded`, `assertGeneratedImage` and `assertNeverGeneratedImage`
mirror the prompt assertions. An unscripted call fails the call and the
disposal, as an unscripted prompt does. The `@guren/plugin-ai` optional peer
floor stays as it is: `imageModel()` is type-only, and the fake is loaded by
dynamic import, so an older plugin fails at `fakeAi()` with the name it is
missing rather than at install.
