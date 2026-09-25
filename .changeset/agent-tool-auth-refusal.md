---
'@guren/server': patch
---

An agent tool call to a route behind `requireAuthenticated({ redirectTo })`, `requireGuest({ redirectTo })` or `requireVerifiedEmail()` now comes back as an error result. The guards recognize the request the agent dispatcher builds (it carries `X-Guren-Agent-Surface`) and answer it with their JSON refusal (`401`, or `403` for the guest and verified-email guards) instead of a redirect, which the dispatcher mapped to a success naming `/login`. A `responseFactory` set beside `redirectTo` is skipped for such a call, since it may redirect too. Browser requests are redirected as before, and a redirect the handler itself returns is still a success. The header only chooses the shape of the refusal and authorizes nothing.
