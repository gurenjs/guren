---
'create-guren-app': patch
---

Exclude the health route that the templates actually define

The default and blog templates excluded `['/healthcheck', '/up']` from host
authorization while their route registrar defines `/health`, so in production the
health endpoint answered 403 to the load balancer probing it. Both now exclude
`['/health']`, matching the API-only template, the generated deploy configs, and
the guides.
