---
'@guren/server': patch
---

Carry the policy's own denial through the authorization middleware

`authorizeMiddleware` and `authorizeResourceMiddleware` called `allows()`,
discarded the response, and threw a generic 403 — so a policy answering with
`denyAsNotFound()` produced a 404 through `Controller.authorize()` and a 403
through the middleware. Both now go through the same response, keeping the
policy's message and status; `options.message` still overrides. Multi-ability
(`any`) checks have no single response to carry and stay generic.

Gate and policy `before` hooks are normalized too: previously anything that was
not a boolean was read as "keep checking", so a `Response.deny()` returned from
`before` was dropped and a permissive ability method then allowed the action.
Only `undefined` continues. `GateCallback`, `GateBeforeCallback`, `Policy.before`
and `definePolicy`'s `before` accept `PolicyResult` to match.
