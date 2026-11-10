---
'@guren/server': patch
---

`SmtpTransport` escapes `"` and `\` in a display name, so a name such as `x" <attacker@example.com>, "y` is shown as written and no longer adds an address to the From, To, Cc, Bcc or Reply-To header. A name that is already one quoted string, as `parseMailAddress('"Jane Doe" <jane@example.com>')` leaves it, is sent as it is.
