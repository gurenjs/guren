---
"@guren/server": minor
"@guren/cli": minor
---

Type a navigation entry's `route` against the app's routes. Once the app has `config/navigation.ts`, `guren codegen` lists in `.guren/routes.gen.ts` each route name every route of which is a `GET` with no path parameter, as the `GurenNavigationRoutes` registry, and `defineNavigation()` rejects any other name at type-check time. An app without the file, or one codegen has not run for, accepts any name, as before. A route a provider registers, which codegen does not read, is added by merging its name into `GurenNavigationRoutes` with `declare module '@guren/core'`. The Vite plugin regenerates when the file is added or removed.
