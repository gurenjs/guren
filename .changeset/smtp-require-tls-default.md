---
'@guren/server': minor
---

`SmtpTransport` defaults `requireTLS` to `true` when `auth` has a user or password, `secure` is off and `host` is not `localhost`, a `127.x` address or `::1`. An attacker on the network path who strips STARTTLS from the server's EHLO reply now makes the send fail, where the credentials and the mail used to go out in cleartext. A mail catcher on the same machine, a connection without credentials and an explicit `requireTLS` are unchanged. A relay that takes credentials without offering STARTTLS now refuses to send until its transport sets `requireTLS: false`.
