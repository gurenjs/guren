---
"@guren/inertia-client": patch
"create-guren-app": patch
---

A typed `<Link>` or `<Form>` now visits its route with the route's own method, so a `QUERY` route sends `query` and a `<Link>` to a `POST` route sends `post`; a route under a verb Inertia has no method for makes `<Form>` throw with the route's name. Sending `query` needs `@inertiajs/react` 3.10 or later in the app; `@guren/inertia-client` still accepts `^3.6.1`, so an app on an older Inertia keeps one copy. New apps start on `@inertiajs/react` `^3.11.0`, which also limits the XSRF token header to same-origin URLs and uses a unique IV for every encrypted history entry.
