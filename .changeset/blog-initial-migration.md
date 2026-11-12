---
"create-guren-app": patch
---

`create-guren-app --blueprint blog` generates the app's first migration (`create_users_and_posts`) after installing dependencies, so the initial commit holds it and the next steps go straight to `bun run db:migrate`. The blog ships its `users` and `posts` tables with no migration, so the first `make:migration add_views_to_posts` a user or an agent ran created both tables under that name. Under `--no-install`, or when the install fails, the next steps still list `bun run db:make`. The other blueprints are unchanged: their first migration is the user's to generate, which the tutorial builds on.
