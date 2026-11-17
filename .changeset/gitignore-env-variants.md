---
"create-guren-app": patch
---

A scaffolded app's `.gitignore` now ignores every `.env.*` file (`.env.local`, `.env.production`, `.env.development.local` and the rest Bun loads) as well as `.env`, keeping `.env.example` committed. Before, only `.env` was ignored, so the `.env.production` the deploy guides fill with `APP_KEY` and `DATABASE_URL` went into the first `git add -A`. Apps scaffolded earlier keep their old `.gitignore`: add `.env.*` and then `!.env.example` below the `.env` line. An env file meant to be committed under another name now needs `git add -f` or its own `!` line.
