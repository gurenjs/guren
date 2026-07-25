---
'@guren/server': minor
---

CSRF protection is now a stateless signed double-submit cookie (RFC 0003 Part 3): the token lives only in the `XSRF-TOKEN` cookie as `random.signature` (HMAC over the app keyring, `APP_PREVIOUS_KEYS` rotation supported) and validation requires both a valid signature — proving this server minted the token, which closes the classic double-submit hole where a sibling-domain attacker plants a matching cookie/header pair — and a timing-safe match against the cookie.

Nothing is stored server-side anymore, so anonymous page views cost zero session writes and no session cookie (completing the write-volume work: a guest GET + form POST roundtrip performs no session store operations at all, which is what makes the default auth stack viable on write-metered databases like Cloudflare D1's free tier). The CSRF middleware no longer requires session middleware to be registered; `getCsrfToken()` no longer throws without it. Tokens stored in sessions by earlier releases keep verifying via a legacy fallback until those sessions expire, so in-flight sessions survive the upgrade — no action required.
