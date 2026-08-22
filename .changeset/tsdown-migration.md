---
"@guren/cli": patch
"@guren/core": patch
"create-guren-app": patch
"@guren/inertia-client": patch
"@guren/openapi": patch
"@guren/orm": patch
"@guren/plugin-cloudflare": patch
"@guren/plugin-lambda": patch
"@guren/plugin-markdown": patch
"@guren/plugin-vercel": patch
"@guren/server": patch
"@guren/testing": patch
---

Build with tsdown instead of tsup, and emit declarations with the native TypeScript 7 compiler. The public file layout of every package is unchanged (same `dist/*.js` / `dist/*.d.ts` entry names, shebangs, and `exports`); only the internal chunk names differ. tsup is unmaintained and its declaration bundler needs the JavaScript compiler API that TypeScript 7 no longer ships.
