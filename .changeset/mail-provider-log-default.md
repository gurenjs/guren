---
"@guren/server": patch
---

Default the built-in mail provider to the log transport

`MailServiceProvider` bound a `MailManager` with no transports, and the
manager's own default is `smtp`, so an app that registered the provider
without configuring mail threw `Mail transport not found: smtp` on its first
send. The provider now binds `{ default: 'log', transports: { log: { driver:
'log' } } }`: every message lands in the server output, which is what the
scaffolded `MailProvider` does in development anyway.

`createMailManager()` itself is unchanged; a manager an app builds with its own
config keeps `smtp` as the default. An app that ran `guren add mail` rebinds
`mail` from its `MailProvider`, so nothing changes for it.
