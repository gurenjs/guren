---
'@guren/create-app': patch
---

Add commented `OAUTH_DISCORD_*` entries to both `.env.example` templates, matching the existing GitHub/Google blocks — `guren make:auth --oauth discord` and `guren add oauth` both point users at `.env.example` for these variable names.
