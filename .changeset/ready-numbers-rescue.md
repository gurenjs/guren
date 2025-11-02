---
"@guren/cli": patch
"@guren/core": patch
"create-guren-app": patch
"@guren/inertia-client": patch
"@guren/orm": patch
"@guren/server": patch
"@guren/testing": patch
---

Fixed registerDevAssets to resolve the bundled Inertia client via @guren/inertia-client/app, rebuilt @guren/server, and confirmed the scaffolded app now loads without blank-screen 404s.
