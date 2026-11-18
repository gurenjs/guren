---
'@guren/server': minor
---

The Vite plugin takes a `manualChunks` option that runs ahead of the built-in vendor grouping, so an app can move one dependency out of the eagerly loaded `vendor` chunk without copying the framework's chunking rules. Return a chunk name, `null` to leave the module to the bundler, or `undefined` to keep the built-in grouping.
