---
"@guren/cli": patch
---

`guren add mail` writes a `MailProvider` that reads the sender from `.env`

The provider hard-coded `noreply@example.com` as the sender, so the
`MAIL_FROM_ADDRESS` and `MAIL_FROM_NAME` a scaffolded `.env` declares had no
effect. It now reads both, falling back to `noreply@example.com` and
`Guren App` when a variable is unset or blank. An existing
`app/Providers/MailProvider.ts` is not changed; edit its `from` line the same
way to pick up the variables.
