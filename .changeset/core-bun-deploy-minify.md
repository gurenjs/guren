---
'@guren/core': patch
---

`@guren/core/internal/deploy-build` exports `BUN_DEPLOY_MINIFY`, the `Bun.build` minify options the Lambda and Vercel builds share (`keepNames` included), and `renamedNameKeyedClasses` / `reportRenamedNameKeyedClasses`, which find a job, event, notification or agent a bundle renamed to `<Name><n>` because another module declares the same top-level name.
