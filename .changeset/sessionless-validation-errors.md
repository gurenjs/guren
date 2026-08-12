---
'@guren/server': patch
---

Deliver Inertia validation errors on apps without a session

Sessions only mount when `createApp({ auth })` is configured, and the Inertia
validation renderer flashed errors to the session guarded by `if (session)` —
so on a fresh scaffold (no auth yet) every validation failure redirected back
with the errors silently dropped. The form appeared to do nothing: no
navigation, no messages, nothing in `form.errors`. The tutorial's Part 1
checkpoint ("Title is required." appears) was impossible to pass before Part 2
installed authentication.

Without a session, the flattened errors now ride across the one redirect in a
short-lived HttpOnly cookie (display-only data, no store required, works on
every runtime), and the shared-props resolver reads them from there into the
same `errors` prop. Reading consumes the flash: a cleanup middleware expires
the cookie on the render that consumed it — and only then, so intermediate
hops (a trailing-slash redirect, an auth bounce) don't burn the errors before
a page shows them, matching session-flash semantics. Fields too large for the
~4KB cookie cap are skipped individually so the rest still arrive. Apps with
a session keep the existing flash path unchanged.
