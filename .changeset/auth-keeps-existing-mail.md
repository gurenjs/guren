---
'@guren/cli': patch
---

`guren add auth` (and `guren make:auth`) no longer fails on an app that already has mail. Before, `guren add mail` followed by `guren add auth` stopped on `config/mail.ts already exists` after writing the auth controllers, pages and model, and `--force` replaced the app's mail config with the auth scaffold's. When a `defineMailConfig()` definition or a provider binding `mail` is already in `app/`, `src/` or `config/`, the command now writes no mail config or provider, registers none, and adds no MAIL_*/SMTP_* keys. The password reset mail sends through the existing binding, and the Next steps no longer ask you to register a mail provider. The reverse order is fixed the same way: `guren add mail` after `guren add auth` writes only its sample mailable and keeps the mail setup auth installed.
