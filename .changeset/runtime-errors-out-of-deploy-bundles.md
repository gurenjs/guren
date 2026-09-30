---
'@guren/server': patch
'@guren/core': patch
---

Keep the development runtime error collector out of deploy bundles. `ExceptionHandler` and `Application` imported it statically, so every Lambda, Vercel and Workers bundle carried its buffer and its `node:fs` import although only `GUREN_MCP=1` in development ever runs it. The capture call ExceptionHandler makes now lives in a small module with no `node:fs`, and `Application` loads the buffer through an `import()` behind a `process.env.NODE_ENV` test the deploy builds settle, so the bundler drops it. In development nothing changes except timing: the buffer is bound once the module loads, which `boot()` waits for, rather than in the constructor.
