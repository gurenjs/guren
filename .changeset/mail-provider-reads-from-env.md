---
"@guren/cli": patch
---

`guren add mail` writes a `MailProvider` that reads the sender from `.env`

The provider hard-coded `noreply@example.com` as the sender, so the
`MAIL_FROM_ADDRESS` and `MAIL_FROM_NAME` a scaffolded `.env` declares had no
effect. It now reads both. A blank or unset address falls back to
`noreply@example.com`; an unset name falls back to `Guren App`, while a blank
one is kept, as `guren add auth`'s `config/mail.ts` does. An existing
`app/Providers/MailProvider.ts` is not changed; edit its `from` line the same
way to pick up the variables.
