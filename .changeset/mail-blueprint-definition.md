---
'@guren/cli': minor
---

`guren add mail` and `guren make:auth` write one `config/mail.ts` as a `defineMailConfig` definition listed in `createApp({ config })` when the app declares its environment in `config/env.ts` and nothing already binds mail (RFC 0027 §2). The definition replaces `MailProvider` and `CoreMailServiceProvider`, ships `log`, `memory` and `smtp` transports, and declares `MAIL_MAILER`, `MAIL_FROM_ADDRESS`, `MAIL_FROM_NAME` and the `SMTP_*` keys. `make:auth` in such an app reads `MAIL_MAILER`, not `MAIL_DRIVER`. An app without `config/env.ts` keeps the provider form; `guren add mail` there now also appends `MAIL_MAILER`, `MAIL_FROM_ADDRESS` and `MAIL_FROM_NAME` to `.env.example` and `.env`.
