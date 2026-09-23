---
'@guren/cli': patch
---

`guren add auth` (and `guren make:auth`) no longer fails on an app whose sources already bind mail. Before, `guren add mail` followed by `guren add auth` stopped on `config/mail.ts already exists` after writing the auth controllers, pages and model, and `--force` replaced the app's mail config with the auth scaffold's. When a `defineMailConfig()` definition or a provider binding `mail` is in `app/`, `src/` or `config/`, the command keeps it, `--force` included: it writes no mail config or provider, registers none, and adds no MAIL_*/SMTP_* keys. The password reset mail sends through that binding, and the Next steps no longer ask you to register a mail provider. `guren add mail` after `guren add auth` is fixed the same way and writes only its sample mailable; under `--force` it too keeps any existing binding, its own included, so delete the file to have it written again. Both commands warn when they can tell that `createApp()` lists the kept provider or definition in neither its `providers` nor its `config` array; a module's binding, a spread, a barrel import or a path alias other than `@/` is not judged.

`make:auth --oauth-only` no longer lists `app/Providers/MailProvider.ts` and `config/mail.ts` among the password-only files to delete, since `guren add mail` writes the same paths. It names them apart and says to delete them only if nothing else sends mail.

The `add` blueprints and `guren check`'s session binding rule no longer take a `*.test.ts` file under `app/`, `src/` or `config/` that fakes a service (`container.instance('mail', fake)`) for the app binding it.
