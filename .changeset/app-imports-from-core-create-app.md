---
'create-guren-app': patch
---

The scaffolded `config/database.ts` imports its database factory and seeder context type from `@guren/core` instead of `@guren/orm`, the same package the scaffolded models and seeders import from. Both packages export the same functions, so existing apps need no change.
