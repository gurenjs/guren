---
'@guren/server': minor
---

`SmtpTransport` accepts `requireTLS` and `tls` and passes them to nodemailer. With `requireTLS: true`, a send to a server that does not upgrade with STARTTLS fails instead of sending credentials and mail in cleartext; `tls` takes Node TLS options such as `ca` for a relay on a private CA. The default stays `false`.
