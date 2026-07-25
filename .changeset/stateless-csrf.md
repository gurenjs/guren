---
'@guren/server': minor
---

CSRF protection moves out of the session into signed tokens (RFC 0003 Part 3), using the app keyring via `MessageSigner` (`APP_PREVIOUS_KEYS` rotation supported). The token is **bound to the session** when a logged-in one exists and **stateless double-submit** for guests:

- **Logged-in (session-bound):** the token carries the session id and is verified against the live session — immune to cookie injection, including a sibling-subdomain attacker who plants their own validly-signed token (it is bound to *their* session id, not the victim's). This preserves the security posture of the previous session-stored token.
- **Guest (stateless):** a signed random token verified against the `XSRF-TOKEN` cookie. Guests hold no authenticated state to protect, and nothing is stored server-side — so anonymous page views cost zero session writes and no session cookie. Completing the write-volume work, a guest GET + form POST roundtrip now performs no session store operations at all, which is what makes the default auth stack viable on write-metered databases like Cloudflare D1's free tier.

The CSRF middleware no longer requires session middleware to be registered; `getCsrfToken()` no longer throws without it. `cookie: false` now works for session-authenticated flows (bound tokens verify without the cookie). Tokens stored in sessions by earlier releases keep verifying via a legacy fallback until those sessions expire, so in-flight sessions survive the upgrade — no action required.
