---
'@guren/server': minor
---

Keep the dev server banner, and the figlet and chalk it needs, out of production bundles. `Application` imports the banner module only outside `NODE_ENV=production`, behind a check the deploy builds' `--define 'process.env.NODE_ENV="production"'` settle at bundle time, so Workers, Lambda and Vercel bundles no longer carry or evaluate it at cold start. `listen()` prints the same banner in development and the same `[guren] Listening on …` line in production.

`Application.logDevServerBanner(options)` keeps its synchronous `void` signature. Two direct calls behave differently: a call made before anything has loaded the banner module prints once the import settles rather than before the call returns, and a call under `NODE_ENV=production` prints nothing, since the module is never loaded there. `Application` is a Stable API, and this behaviour change to one of its methods ships in a minor release on purpose.

To print the banner in production, call `logDevServerBanner()` from `@guren/core/runtime` (`@guren/server/runtime`), which still prints unconditionally. A production entry that imports `logDevServerBanner` or `GUREN_ASCII_ART` from that subpath brings the banner back into its bundle; importing only its other names, such as `autoConfigureInertiaAssets`, does not. The deploy entries the current templates scaffold import neither.
