---
'@guren/cli': patch
---

The `guren-new-app` agent-catalog skill now says what `bunx guren` does outside an app: the npm `guren` package is a placeholder that prints how to create an app and exits 1, and the real command comes from the app's local `@guren/cli`.
