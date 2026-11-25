---
"@guren/server": minor
"@guren/cli": minor
---

Type a navigation entry's `route` against the app's routes. Once the app has `config/navigation.ts`, `guren codegen` lists in `.guren/routes.gen.ts` each route name every route of which is a `GET` with no path parameter, as the `GurenNavigationRoutes` registry, and `defineNavigation()` rejects any other name at type-check time. An app without the file, or one codegen has not run for, accepts any name, as before. The Vite plugin regenerates when the file is added or removed.
