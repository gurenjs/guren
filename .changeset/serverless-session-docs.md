---
'@guren/plugin-lambda': patch
---

Update the serverless guide's session section for RFC 0020

It still documented `app.use(createSessionMiddleware({ store: new DatabaseSessionStore(sessions) }))`, which the config path replaced, and `store.deleteExpired()` where `sessions:prune` is now the scheduled command. Both language versions now start from `guren add session` and document the `dynamodb` driver beside it.
